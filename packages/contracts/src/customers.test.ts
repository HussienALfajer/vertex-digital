import { describe, expect, it } from 'vitest';
import { ADMIN_SESSION_RULES } from './admin.js';
import { customerStatus } from './customer-status.js';
import {
  classifyCustomerSearch,
  createCustomerNoteSchema,
  createdTestCustomerSchema,
  createTestCustomerSchema,
  customerLimits,
  customerNoteListQuerySchema,
  customerSearchQuerySchema,
  effectiveDepositLimitSettings,
  NO_LIMIT_OVERRIDES,
  purchaseCapBreach,
  updateCustomerLimitsSchema,
} from './customers.js';
import { cursorQuerySchema } from './lists.js';

describe('test customers', () => {
  it('are created with a name, an email and a phone', () => {
    const input = { name: 'زبون تجريبي', email: 't@example.com', phone: '0944123456' };
    expect(createTestCustomerSchema.parse(input)).toEqual({ ...input, phone: '+963944123456' });
  });

  it('come back once with their password', () => {
    const created = {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'زبون تجريبي',
      email: 't@example.com',
      phone: '+963944123456',
      createdAt: '2026-10-07T10:00:00.000Z',
      password: 'generated',
    };
    expect(createdTestCustomerSchema.parse(created)).toEqual(created);
  });
});

describe('cursor lists', () => {
  it('default to 50 items and take an opaque cursor', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(cursorQuerySchema.parse({ cursor: 'abc', limit: '10' })).toEqual({
      cursor: 'abc',
      limit: 10,
    });
    expect(cursorQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('admin session rules (D4, D5)', () => {
  it('end a session after 30 idle minutes or 12 hours; re-authentication lasts 5 minutes', () => {
    expect(ADMIN_SESSION_RULES).toEqual({
      idleTimeoutMs: 1_800_000,
      absoluteLifetimeMs: 43_200_000,
      reauthenticationMs: 300_000,
    });
  });
});

describe('customer status (S12)', () => {
  it('is archived before frozen before active', () => {
    expect(customerStatus({ frozenAt: null, archivedAt: null })).toBe('active');
    expect(customerStatus({ frozenAt: new Date(), archivedAt: null })).toBe('frozen');
    expect(customerStatus({ frozenAt: new Date(), archivedAt: '2026-10-10T00:00:00Z' })).toBe(
      'archived',
    );
  });
});

describe('customer search (CS1)', () => {
  it('finds order, deposit and ticket numbers first', () => {
    expect(classifyCustomerSearch(' vo-7kq2mx ')).toEqual({ kind: 'order', number: 'VO-7KQ2MX' });
    expect(classifyCustomerSearch('VD7KQ2M')).toEqual({
      kind: 'deposit',
      referenceCode: 'VD-7KQ2M',
    });
    expect(classifyCustomerSearch('vt-7kq2mx')).toEqual({ kind: 'ticket', number: 'VT-7KQ2MX' });
  });

  it('reads a malformed number as text', () => {
    expect(classifyCustomerSearch('VO-1')).toEqual({ kind: 'text', text: 'VO-1' });
    expect(classifyCustomerSearch('vd-x')).toEqual({ kind: 'text', text: 'vd-x' });
    expect(classifyCustomerSearch('vt-x')).toEqual({ kind: 'text', text: 'vt-x' });
  });

  it('matches emails by prefix, lowercased', () => {
    expect(classifyCustomerSearch('Ali@Ex')).toEqual({ kind: 'email', prefix: 'ali@ex' });
  });

  it('normalizes phones to E.164, or keeps the digits for a suffix match', () => {
    expect(classifyCustomerSearch('0944 123 456')).toEqual({
      kind: 'phone',
      e164: '+963944123456',
      digits: '0944123456',
    });
    expect(classifyCustomerSearch('123456')).toEqual({
      kind: 'phone',
      e164: null,
      digits: '123456',
    });
  });

  it('falls back to name or email text', () => {
    expect(classifyCustomerSearch('12345')).toEqual({ kind: 'text', text: '12345' });
    expect(classifyCustomerSearch('علي')).toEqual({ kind: 'text', text: 'علي' });
  });

  it('defaults to every status, 25 a page', () => {
    expect(customerSearchQuerySchema.parse({})).toEqual({ status: 'all', limit: 25 });
  });
});

const SETTINGS = {
  minDepositUsdUnits: 2_000_000,
  newAccountPerDepositUsdUnits: 50_000_000,
  newAccountDailyUsdUnits: 100_000_000,
  establishedPerDepositUsdUnits: 200_000_000,
  establishedDailyUsdUnits: 500_000_000,
};

describe('limits (LM2–LM5)', () => {
  it('keep the tiers without overrides', () => {
    expect(effectiveDepositLimitSettings(SETTINGS, NO_LIMIT_OVERRIDES, null)).toEqual(SETTINGS);
  });

  it('replace both tiers with each override, the minimum unchanged', () => {
    expect(
      effectiveDepositLimitSettings(
        SETTINGS,
        {
          perDepositUsdUnits: 500_000_000,
          dailyDepositUsdUnits: null,
        },
        null,
      ),
    ).toEqual({
      ...SETTINGS,
      newAccountPerDepositUsdUnits: 500_000_000,
      establishedPerDepositUsdUnits: 500_000_000,
    });
    expect(
      effectiveDepositLimitSettings(
        SETTINGS,
        {
          perDepositUsdUnits: null,
          dailyDepositUsdUnits: 10_000_000,
        },
        null,
      ),
    ).toEqual({
      ...SETTINGS,
      newAccountDailyUsdUnits: 10_000_000,
      establishedDailyUsdUnits: 10_000_000,
    });
  });

  it('say where each limit comes from', () => {
    expect(customerLimits(SETTINGS, false, NO_LIMIT_OVERRIDES, null).effective).toEqual({
      perDeposit: { units: 50_000_000, source: 'default_new' },
      dailyDeposit: { units: 100_000_000, source: 'default_new' },
      dailyPurchase: { units: null, source: 'none' },
    });
    const custom = {
      perDepositUsdUnits: 1_000_000,
      dailyDepositUsdUnits: null,
      dailyPurchaseUsdUnits: 20_000_000,
    };
    expect(customerLimits(SETTINGS, true, custom, null)).toEqual({
      ...custom,
      effective: {
        perDeposit: { units: 1_000_000, source: 'custom' },
        dailyDeposit: { units: 500_000_000, source: 'default_established' },
        dailyPurchase: { units: 20_000_000, source: 'custom' },
      },
    });
  });

  it('take the merchant tier for both tiers, the overrides still winning (S20 MD1, MD2)', () => {
    const tier = { perDepositUsdUnits: 2_000_000_000, dailyDepositUsdUnits: 5_000_000_000 };
    expect(effectiveDepositLimitSettings(SETTINGS, NO_LIMIT_OVERRIDES, tier)).toEqual({
      ...SETTINGS,
      newAccountPerDepositUsdUnits: 2_000_000_000,
      establishedPerDepositUsdUnits: 2_000_000_000,
      newAccountDailyUsdUnits: 5_000_000_000,
      establishedDailyUsdUnits: 5_000_000_000,
    });
    expect(
      effectiveDepositLimitSettings(
        SETTINGS,
        { perDepositUsdUnits: 100_000_000, dailyDepositUsdUnits: null },
        tier,
      ),
    ).toMatchObject({
      newAccountPerDepositUsdUnits: 100_000_000,
      establishedDailyUsdUnits: 5_000_000_000,
    });
    expect(
      customerLimits(
        SETTINGS,
        false,
        { ...NO_LIMIT_OVERRIDES, dailyDepositUsdUnits: 1_000_000 },
        tier,
      ).effective,
    ).toEqual({
      perDeposit: { units: 2_000_000_000, source: 'default_merchant' },
      dailyDeposit: { units: 1_000_000, source: 'custom' },
      dailyPurchase: { units: null, source: 'none' },
    });
  });

  it('cap purchases at the boundary', () => {
    expect(purchaseCapBreach(null, 1e12, 1e12)).toBeNull();
    expect(purchaseCapBreach(20_000_000, 15_000_000, 5_000_000)).toBeNull();
    expect(purchaseCapBreach(20_000_000, 15_000_000, 5_000_001)).toEqual({
      limitUnits: 20_000_000,
      remainingUnits: 5_000_000,
    });
    expect(purchaseCapBreach(20_000_000, 25_000_000, 1)).toEqual({
      limitUnits: 20_000_000,
      remainingUnits: 0,
    });
  });

  it('take positive whole cents up to $100,000, per deposit within the daily', () => {
    const base = {
      perDepositUsdUnits: null,
      dailyDepositUsdUnits: null,
      dailyPurchaseUsdUnits: null,
      reason: 'عميل موثوق',
    };
    expect(updateCustomerLimitsSchema.safeParse(base).success).toBe(true);
    expect(
      updateCustomerLimitsSchema.safeParse({ ...base, dailyPurchaseUsdUnits: 1_005_000 }).success,
    ).toBe(false);
    expect(updateCustomerLimitsSchema.safeParse({ ...base, perDepositUsdUnits: 0 }).success).toBe(
      false,
    );
    expect(
      updateCustomerLimitsSchema.safeParse({ ...base, perDepositUsdUnits: 100_000_010_000 })
        .success,
    ).toBe(false);
    expect(
      updateCustomerLimitsSchema.safeParse({
        ...base,
        perDepositUsdUnits: 20_000_000,
        dailyDepositUsdUnits: 10_000_000,
      }).success,
    ).toBe(false);
    expect(
      updateCustomerLimitsSchema.safeParse({
        ...base,
        perDepositUsdUnits: 10_000_000,
        dailyDepositUsdUnits: 10_000_000,
      }).success,
    ).toBe(true);
    expect(updateCustomerLimitsSchema.safeParse({ ...base, reason: 'قصير' }).success).toBe(false);
  });
});

describe('notes (SN2)', () => {
  it('keep new lines, refuse empty bodies and default to unpinned', () => {
    expect(createCustomerNoteSchema.parse({ body: ' سطر\r\nثانٍ ' })).toEqual({
      body: 'سطر\nثانٍ',
      pinned: false,
    });
    expect(createCustomerNoteSchema.safeParse({ body: ' ' }).success).toBe(false);
  });

  it('list active notes unless archived ones are asked for', () => {
    expect(customerNoteListQuerySchema.parse({}).archived).toBe(false);
    expect(customerNoteListQuerySchema.parse({ archived: 'true' }).archived).toBe(true);
  });
});
