import { describe, expect, it } from 'vitest';
import { contrastRatio } from './catalog.js';
import { CURRENCY_SCALE } from './money.js';
import {
  acceptShopInvitationSchema,
  approveShopSchema,
  brandColorProblem,
  brandColorSchema,
  createReturnRequestSchema,
  hasLink,
  RESERVED_SHOP_SLUGS,
  requestShopSchema,
  returnRequestTransition,
  SHOP_BRAND_COLORS,
  SHOP_LIGHT_BACKGROUND,
  SHOP_STATUSES,
  SHOP_TRANSFER_MIN_USD_UNITS,
  type ShopAction,
  type ShopStatus,
  shopAnnouncementSchema,
  shopCustomerState,
  shopLimitsSchema,
  shopRate,
  shopRateIsFar,
  shopRequestAgainAt,
  shopSettingsSchema,
  shopSignUpSchema,
  shopSlugSchema,
  shopTransferRefusal,
  shopTransferUsd,
  shopTransition,
  updateShopCustomerSchema,
  updateShopSchema,
} from './shops.js';

const USD = CURRENCY_SCALE.USD;

describe('shopTransition (S26 shop states)', () => {
  const allowed: Record<ShopAction, [ShopStatus, ShopStatus][]> = {
    approve: [['requested', 'active']],
    reject: [['requested', 'rejected']],
    suspend: [['active', 'suspended']],
    resume: [['suspended', 'active']],
    close: [
      ['active', 'closed'],
      ['suspended', 'closed'],
    ],
  };

  it('allows exactly the table and refuses every other move', () => {
    for (const [action, moves] of Object.entries(allowed) as [
      ShopAction,
      [ShopStatus, ShopStatus][],
    ][]) {
      for (const status of SHOP_STATUSES) {
        const move = moves.find(([from]) => from === status);
        expect(shopTransition(status, action), `${action} from ${status}`).toBe(move?.[1] ?? null);
      }
    }
  });

  it('lets a rejected merchant request again after 7 days (SH1)', () => {
    expect(shopRequestAgainAt(new Date('2026-11-10T10:00:00Z')).toISOString()).toBe(
      '2026-11-17T10:00:00.000Z',
    );
  });
});

describe('shopSlugSchema (SH2)', () => {
  it('accepts lowercase letters, digits and inner hyphens, 3–30 long, lowercasing input', () => {
    expect(shopSlugSchema.parse('abc')).toBe('abc');
    expect(shopSlugSchema.parse(' Al-Noor-2 ')).toBe('al-noor-2');
    expect(shopSlugSchema.parse('a'.repeat(30))).toBe('a'.repeat(30));
  });

  it.each(['ab', 'a'.repeat(31), '-abc', 'abc-', 'ab_c', 'متجر', 'ab c'])('refuses %j', (slug) => {
    expect(shopSlugSchema.safeParse(slug).success).toBe(false);
  });

  it('refuses every reserved word', () => {
    for (const slug of RESERVED_SHOP_SLUGS) {
      expect(shopSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });
});

describe('brand colors (ST1)', () => {
  it('passes the 12 ready colors', () => {
    expect(SHOP_BRAND_COLORS).toHaveLength(12);
    expect(new Set(SHOP_BRAND_COLORS).size).toBe(12);
    for (const color of SHOP_BRAND_COLORS) expect(brandColorProblem(color), color).toBeNull();
  });

  it('names why a color is refused', () => {
    expect(brandColorProblem('#ffd700')).toBe('white_text');
    expect(brandColorProblem('#1a1a1a')).toBe('dark_theme');
    expect(brandColorProblem('#4f55c9')).toBe('dark_theme');
    expect(brandColorProblem('#4a6274')).toBe('dark_theme');
  });

  it('passes the light background whenever white text passes', () => {
    expect(contrastRatio('#c0392b', SHOP_LIGHT_BACKGROUND)).toBeGreaterThanOrEqual(3);
    expect(brandColorProblem('#d0302b')).toBeNull();
  });

  it('validates hex and the contrast in the schema', () => {
    expect(brandColorSchema.parse('#1F7A6C')).toBe('#1f7a6c');
    expect(brandColorSchema.safeParse('#fff').success).toBe(false);
    const refused = brandColorSchema.safeParse('#ffd700');
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe('BRAND_COLOR_WHITE_TEXT');
  });
});

describe('shopAnnouncementSchema (ST5)', () => {
  it('accepts plain text with a phone number', () => {
    expect(shopAnnouncementSchema.parse(' عروض الجمعة: اتصل 0944 123 456 ')).toBe(
      'عروض الجمعة: اتصل 0944 123 456',
    );
  });

  it.each([
    'زوروا https://example.com',
    'زوروا http://x.y',
    'www.shop.sy',
    'راسلنا على a@b.co',
    'زوروا shop.com الآن',
    '',
    'x'.repeat(201),
  ])('refuses %j', (text) => {
    expect(shopAnnouncementSchema.safeParse(text).success).toBe(false);
  });

  it('detects links', () => {
    expect(hasLink('اتصل 0944123456')).toBe(false);
    expect(hasLink('my.store link')).toBe(true);
  });
});

describe('shop rate (ST3)', () => {
  it('is far only beyond 10% either way', () => {
    expect(shopRateIsFar('10000', '11000')).toBe(false);
    expect(shopRateIsFar('10000', '11000.01')).toBe(true);
    expect(shopRateIsFar('10000', '9000')).toBe(false);
    expect(shopRateIsFar('10000', '8999')).toBe(true);
    expect(shopRateIsFar(null, '1')).toBe(false);
  });

  it('follows the store unless an own rate is set', () => {
    expect(shopRate('store', '12000', '11000')).toBe('11000');
    expect(shopRate('own', '12000', '11000')).toBe('12000');
    expect(shopRate('own', null, '11000')).toBe('11000');
    expect(shopRate('store', null, null)).toBeNull();
  });
});

describe('shopLimitsSchema (SH8)', () => {
  const limits = {
    customerBalanceCapUsdUnits: 200 * USD,
    dailyTransferCapUsdUnits: 1_000 * USD,
    customerLimit: 2_000,
  };

  it('accepts the ranges', () => {
    expect(shopLimitsSchema.parse(limits)).toEqual(limits);
    expect(
      shopLimitsSchema.safeParse({ ...limits, customerBalanceCapUsdUnits: 5_000 * USD }).success,
    ).toBe(true);
  });

  it.each([
    { customerBalanceCapUsdUnits: 0.99 * USD },
    { customerBalanceCapUsdUnits: 5_000 * USD + 10_000 },
    { customerBalanceCapUsdUnits: 100 * USD + 1 },
    { dailyTransferCapUsdUnits: 9 * USD },
    { dailyTransferCapUsdUnits: 50_001 * USD },
    { customerLimit: 0 },
    { customerLimit: 20_001 },
  ])('refuses %j', (change) => {
    expect(shopLimitsSchema.safeParse({ ...limits, ...change }).success).toBe(false);
  });
});

describe('shopTransferUsd (WL2)', () => {
  it('takes USD in whole cents as entered', () => {
    expect(shopTransferUsd('usd', 5 * USD, null)).toBe(5 * USD);
    expect(shopTransferUsd('usd', 5 * USD + 1, '11000')).toBeNull();
  });

  it('converts whole pounds at the rate, rounded down to cents', () => {
    // 10,000 SYP at 11,000 = 0.909090… USD → $0.90.
    expect(shopTransferUsd('syp', 10_000 * CURRENCY_SCALE.SYP, '11000')).toBe(900_000);
    // 22,000 SYP at 11,000 = exactly $2.
    expect(shopTransferUsd('syp', 22_000 * CURRENCY_SCALE.SYP, '11000')).toBe(2 * USD);
  });

  it('refuses fractional pounds, a missing rate and non-positive amounts', () => {
    expect(shopTransferUsd('syp', 150, '11000')).toBeNull();
    expect(shopTransferUsd('syp', 10_000, null)).toBeNull();
    expect(shopTransferUsd('usd', 0, null)).toBeNull();
    expect(shopTransferUsd('usd', -USD, null)).toBeNull();
    expect(shopTransferUsd('usd', 0.5, null)).toBeNull();
  });
});

describe('shopTransferRefusal (WL2, WL3)', () => {
  const state = {
    amountUsdUnits: 10 * USD,
    merchantBalanceUsdUnits: 100 * USD,
    customerBalanceUsdUnits: 50 * USD,
    balanceCapUsdUnits: 200 * USD,
    transferredTodayUsdUnits: 0,
    dailyCapUsdUnits: 1_000 * USD,
  };

  it('allows a transfer within every limit, up to the caps exactly', () => {
    expect(shopTransferRefusal(state)).toBeNull();
    expect(
      shopTransferRefusal({ ...state, amountUsdUnits: SHOP_TRANSFER_MIN_USD_UNITS }),
    ).toBeNull();
    expect(
      shopTransferRefusal({
        ...state,
        amountUsdUnits: 100 * USD,
        customerBalanceUsdUnits: 100 * USD,
      }),
    ).toBeNull();
    expect(shopTransferRefusal({ ...state, transferredTodayUsdUnits: 990 * USD })).toBeNull();
  });

  it('refuses below the minimum', () => {
    expect(shopTransferRefusal({ ...state, amountUsdUnits: 90_000 })).toEqual({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses more than the merchant holds', () => {
    expect(shopTransferRefusal({ ...state, merchantBalanceUsdUnits: 9 * USD })).toEqual({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('refuses above the balance cap with the largest amount allowed', () => {
    expect(shopTransferRefusal({ ...state, customerBalanceUsdUnits: 195 * USD })).toEqual({
      code: 'SHOP_BALANCE_CAP_EXCEEDED',
      largestUsdUnits: 5 * USD,
    });
    // SH8: a cap lowered below the balance leaves nothing, never a negative amount.
    expect(shopTransferRefusal({ ...state, customerBalanceUsdUnits: 250 * USD })).toEqual({
      code: 'SHOP_BALANCE_CAP_EXCEEDED',
      largestUsdUnits: 0,
    });
  });

  it('refuses above the daily cap with what is left today', () => {
    expect(shopTransferRefusal({ ...state, transferredTodayUsdUnits: 995 * USD })).toEqual({
      code: 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED',
      remainingUsdUnits: 5 * USD,
    });
    expect(
      shopTransferRefusal({
        ...state,
        transferredTodayUsdUnits: 1_200 * USD,
        dailyCapUsdUnits: 1_000 * USD,
      }),
    ).toEqual({ code: 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED', remainingUsdUnits: 0 });
  });
});

describe('returnRequestTransition (WL5)', () => {
  it('ends only a pending request', () => {
    expect(returnRequestTransition('pending', 'confirm')).toBe('confirmed');
    expect(returnRequestTransition('pending', 'decline')).toBe('declined');
    expect(returnRequestTransition('pending', 'expire')).toBe('expired');
    expect(returnRequestTransition('pending', 'cancel')).toBe('cancelled');
    for (const status of ['confirmed', 'declined', 'expired', 'cancelled'] as const) {
      expect(returnRequestTransition(status, 'confirm')).toBeNull();
    }
  });
});

describe('shopCustomerState', () => {
  const base = { emailVerified: true, hasPassword: true, frozenAt: null, archivedAt: null };

  it('reads the state the merchant sees', () => {
    expect(shopCustomerState(base)).toBe('active');
    expect(shopCustomerState({ ...base, emailVerified: false })).toBe('unverified');
    expect(shopCustomerState({ ...base, hasPassword: false, emailVerified: false })).toBe(
      'invited',
    );
    expect(shopCustomerState({ ...base, frozenAt: new Date() })).toBe('frozen');
    expect(shopCustomerState({ ...base, frozenAt: new Date(), archivedAt: new Date() })).toBe(
      'archived',
    );
  });
});

describe('request and settings schemas', () => {
  it('needs a rate with an own rate', () => {
    const request = { slug: 'al-noor', brandColor: '#1f7a6c', rateMode: 'own' as const };
    expect(requestShopSchema.safeParse(request).success).toBe(false);
    expect(requestShopSchema.parse({ ...request, rate: '12000' })).toMatchObject({
      rate: '12000',
      confirmFar: false,
    });
    expect(requestShopSchema.parse({ ...request, rateMode: 'store' }).rate).toBeNull();
  });

  it('needs something to change', () => {
    expect(shopSettingsSchema.safeParse({}).success).toBe(false);
    expect(shopSettingsSchema.safeParse({ confirmFar: true }).success).toBe(false);
    expect(shopSettingsSchema.safeParse({ announcement: null }).success).toBe(true);
    expect(shopSettingsSchema.safeParse({ rate: '12000', confirmFar: true }).success).toBe(true);
    expect(shopSettingsSchema.safeParse({ rateMode: 'store' }).success).toBe(true);
    expect(shopSettingsSchema.safeParse({ brandColor: '#2266b3' }).success).toBe(true);
    expect(updateShopCustomerSchema.safeParse({}).success).toBe(false);
    expect(updateShopCustomerSchema.safeParse({ name: 'سامي علي' }).success).toBe(true);
    expect(updateShopSchema.safeParse({ reason: 'تصحيح' }).success).toBe(false);
    expect(updateShopSchema.safeParse({ reason: 'تصحيح', clearAnnouncement: true }).success).toBe(
      true,
    );
  });

  it('validates the rest of the inputs', () => {
    expect(
      approveShopSchema.safeParse({
        limits: {
          customerBalanceCapUsdUnits: USD,
          dailyTransferCapUsdUnits: 10 * USD,
          customerLimit: 1,
        },
      }).success,
    ).toBe(true);
    expect(createReturnRequestSchema.safeParse({ amountUsdUnits: 0 }).success).toBe(false);
    expect(createReturnRequestSchema.safeParse({ amountUsdUnits: USD }).success).toBe(true);
    expect(
      shopSignUpSchema.safeParse({
        name: 'سامي علي',
        email: 'sami@example.com',
        password: 'a-long-passphrase',
        phone: '0944123456',
        acceptTerms: true,
      }).success,
    ).toBe(true);
    expect(acceptShopInvitationSchema.safeParse({ token: 'short', password: 'x' }).success).toBe(
      false,
    );
  });
});
