import { describe, expect, it } from 'vitest';
import {
  APPLICATION_ACTION_EVENTS,
  type ApplicationAction,
  applicationTransition,
  approveApplicationSchema,
  certificatePath,
  grantMerchantSchema,
  infoRequestExpiresAt,
  isOpenApplication,
  MERCHANT_APPLICATION_STATUSES,
  MERCHANT_SETTINGS_DEFAULTS,
  type MerchantApplicationStatus,
  merchantApplicationInputSchema,
  merchantApplyRefusal,
  merchantMessageSchema,
  merchantSettingsInputSchema,
  publicCertificateSchema,
  reapplyAvailableAt,
} from './merchants.js';

const ID = '01900000-0000-7000-8000-000000000001';

const FORM = {
  tradeName: '  محل النور  ',
  activity: 'phone_shop',
  activityOther: null,
  yearsInBusiness: '1_3',
  governorate: 'aleppo',
  city: 'اعزاز',
  streetAddress: 'شارع السوق، قرب الجامع',
  whatsapp: '0933 123 456',
  telegramUsername: '@nour_shop',
  monthlyVolume: '500_2000',
  productInterests: ['game_topups', 'gift_cards'],
  salesChannels: ['shop_counter'],
  shopPhotoFileId: null,
  shopLink: 'https://instagram.com/nour',
  termsVersionId: ID,
  heardFrom: null,
} as const;

describe('applicationTransition (MA4)', () => {
  const table: [MerchantApplicationStatus, ApplicationAction, MerchantApplicationStatus][] = [
    ['under_review', 'request_info', 'info_requested'],
    ['info_requested', 'resubmit', 'under_review'],
    ['under_review', 'approve', 'approved'],
    ['under_review', 'reject', 'rejected'],
    ['under_review', 'withdraw', 'withdrawn'],
    ['info_requested', 'withdraw', 'withdrawn'],
    ['info_requested', 'expire', 'expired'],
    ['under_review', 'grant', 'approved'],
    ['info_requested', 'grant', 'approved'],
  ];

  it('allows exactly the table', () => {
    const actions = Object.keys(APPLICATION_ACTION_EVENTS) as ApplicationAction[];
    for (const status of MERCHANT_APPLICATION_STATUSES) {
      for (const action of actions) {
        const allowed = table.find(([from, by]) => from === status && by === action);
        expect(applicationTransition(status, action), `${status} ${action}`).toBe(
          allowed?.[2] ?? null,
        );
      }
    }
  });

  it('names the event each action writes', () => {
    expect(APPLICATION_ACTION_EVENTS.grant).toBe('approved');
    expect(APPLICATION_ACTION_EVENTS.resubmit).toBe('resubmitted');
  });

  it('knows the open statuses', () => {
    expect(MERCHANT_APPLICATION_STATUSES.filter(isOpenApplication)).toEqual([
      'under_review',
      'info_requested',
    ]);
  });
});

describe('merchantApplyRefusal (MA1, MT1)', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  const base = {
    accountType: 'customer' as const,
    frozen: false,
    termsPublished: true,
    latest: null,
    reapplyWaitDays: 7,
    now,
  };

  it('allows a first application', () => {
    expect(merchantApplyRefusal(base)).toBeNull();
  });

  it('refuses in order: merchant, frozen, no terms, open, too soon', () => {
    expect(merchantApplyRefusal({ ...base, accountType: 'merchant', frozen: true })).toEqual({
      code: 'ALREADY_MERCHANT',
    });
    expect(merchantApplyRefusal({ ...base, frozen: true, termsPublished: false })).toEqual({
      code: 'ACCOUNT_FROZEN',
    });
    expect(merchantApplyRefusal({ ...base, termsPublished: false })).toEqual({
      code: 'MERCHANT_TERMS_UNAVAILABLE',
    });
    expect(
      merchantApplyRefusal({
        ...base,
        latest: { id: ID, status: 'info_requested', decidedAt: null },
      }),
    ).toEqual({ code: 'MERCHANT_APPLICATION_OPEN', applicationId: ID });
  });

  it('waits after a rejection, allowing the exact day (edge case 13)', () => {
    const decidedAt = new Date('2026-10-14T10:00:00Z');
    const rejected = { id: ID, status: 'rejected' as const, decidedAt };
    expect(
      merchantApplyRefusal({ ...base, latest: rejected, now: new Date('2026-10-21T09:59:59Z') }),
    ).toEqual({ code: 'MERCHANT_REAPPLY_TOO_SOON', availableAt: now });
    expect(merchantApplyRefusal({ ...base, latest: rejected })).toBeNull();
    expect(merchantApplyRefusal({ ...base, latest: { ...rejected, decidedAt: null } })).toBeNull();
  });

  it('lets a revoked, withdrawn or expired customer apply at once', () => {
    for (const status of ['approved', 'withdrawn', 'expired'] as const) {
      expect(
        merchantApplyRefusal({ ...base, latest: { id: ID, status, decidedAt: now } }),
      ).toBeNull();
    }
  });

  it('dates the reapply and the expiry', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    expect(reapplyAvailableAt(at, 0)).toEqual(at);
    expect(infoRequestExpiresAt(at, 7)).toEqual(new Date('2026-10-08T00:00:00Z'));
  });
});

describe('merchantApplicationInputSchema (MA2)', () => {
  it('trims, normalizes the phone and the Telegram username', () => {
    const parsed = merchantApplicationInputSchema.parse(FORM);
    expect(parsed.tradeName).toBe('محل النور');
    expect(parsed.whatsapp).toBe('+963933123456');
    expect(parsed.telegramUsername).toBe('nour_shop');
  });

  it('asks "other" for its text, and only "other"', () => {
    expect(merchantApplicationInputSchema.safeParse({ ...FORM, activity: 'other' }).success).toBe(
      false,
    );
    expect(
      merchantApplicationInputSchema.safeParse({ ...FORM, activityOther: 'خدمات' }).success,
    ).toBe(false);
    expect(
      merchantApplicationInputSchema.safeParse({
        ...FORM,
        activity: 'other',
        activityOther: 'مكتبة',
      }).success,
    ).toBe(true);
  });

  it('refuses links outside the shop link, control characters and repeats', () => {
    const refused = [
      { tradeName: 'زوروا www.example.com' },
      { city: 'http://x' },
      { streetAddress: 'shop.com/abc street' },
      { tradeName: 'a\u0007b' },
      { productInterests: ['gift_cards', 'gift_cards'] },
      { productInterests: [] },
      { salesChannels: [] },
      { shopLink: 'http://example.com' },
      { telegramUsername: 'ab' },
      { whatsapp: '123' },
    ];
    for (const change of refused) {
      expect(
        merchantApplicationInputSchema.safeParse({ ...FORM, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it('takes the optional fields as null', () => {
    expect(
      merchantApplicationInputSchema.safeParse({
        ...FORM,
        telegramUsername: null,
        shopLink: null,
        heardFrom: 'facebook',
      }).success,
    ).toBe(true);
  });
});

describe('admin inputs', () => {
  it('need a message of 5 to 500 characters, new lines kept', () => {
    expect(merchantMessageSchema.safeParse('ناقص').success).toBe(false);
    expect(merchantMessageSchema.parse(' أرسل صورة المحل\nمن الخارج ')).toBe(
      'أرسل صورة المحل\nمن الخارج',
    );
    expect(merchantMessageSchema.safeParse('a\u0007bcdef').success).toBe(false);
  });

  it('approve with or without a list, and grant with the form', () => {
    expect(approveApplicationSchema.parse({})).toEqual({});
    expect(
      grantMerchantSchema.safeParse({
        tradeName: 'محل',
        governorate: 'damascus',
        city: 'دمشق',
        reason: 'تاجر معروف لدينا',
      }).success,
    ).toBe(true);
  });
});

describe('merchant settings', () => {
  it('accept the defaults within their bounds', () => {
    expect(merchantSettingsInputSchema.safeParse(MERCHANT_SETTINGS_DEFAULTS).success).toBe(true);
    expect(
      merchantSettingsInputSchema.safeParse({
        ...MERCHANT_SETTINGS_DEFAULTS,
        ordersPerTenMinutes: 9,
      }).success,
    ).toBe(false);
  });

  it('normalize the Diamond contact (OP4) and refuse a bad username', () => {
    expect(
      merchantSettingsInputSchema.parse({
        ...MERCHANT_SETTINGS_DEFAULTS,
        directContactWhatsapp: '0933 123 456',
        directContactTelegram: 'vertex_shop',
      }),
    ).toMatchObject({
      directContactWhatsapp: '+963933123456',
      directContactTelegram: 'vertex_shop',
    });
    for (const directContactTelegram of ['abc', '@vertex_shop', 'vertex shop']) {
      expect(
        merchantSettingsInputSchema.safeParse({
          ...MERCHANT_SETTINGS_DEFAULTS,
          directContactTelegram,
        }).success,
      ).toBe(false);
    }
  });
});

describe('the certificate (ID7)', () => {
  it('points the QR at the public page and shows a revoked merchant as nothing else', () => {
    expect(certificatePath('abcdefghijklmnopqrstuv')).toBe('/m/abcdefghijklmnopqrstuv');
    expect(publicCertificateSchema.parse({ status: 'revoked', tradeName: 'x' })).toEqual({
      status: 'revoked',
    });
  });
});
