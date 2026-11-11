import { describe, expect, it } from 'vitest';
import { shopCacheTag, storeCacheTag } from './jobs.js';
import { NO_SELLING_SETTINGS } from './merchant-tools.js';
import {
  isBotUserAgent,
  SHOP_COMPENSATION_WINDOW_DAYS,
  SHOP_RETURN_ALERT_MIN_USD_UNITS,
  shopCompensationAmounts,
  shopCompensationRefusal,
  shopGameSchema,
  shopIconQuerySchema,
  shopOrderAmounts,
  shopOrderSchema,
  shopPackSellable,
  shopPurchaseSchema,
  shopReturnsAlarming,
  shopSellingPrice,
  shopSellingSyp,
  shopStorefrontSchema,
  shopTicketCustomerMayEscalate,
} from './shop-selling.js';

const USD = 1_000_000;
const CENT = 10_000;
const HOUR = 60 * 60 * 1000;

describe('shopSellingPrice (PR2)', () => {
  it('takes an own USD price as set', () => {
    expect(
      shopSellingPrice(
        5 * USD,
        NO_SELLING_SETTINGS,
        { currency: 'usd', amountUnits: 7 * USD },
        null,
      ),
    ).toBe(7 * USD);
  });

  it('converts an own SYP price at the shop rate, rounded up to whole cents', () => {
    // 10,000 SYP at 13,000.0000 SYP per USD = 0.769230… USD → 0.77.
    expect(
      shopSellingPrice(
        50 * CENT,
        NO_SELLING_SETTINGS,
        { currency: 'syp', amountUnits: 10_000 * 100 },
        '13000.0000',
      ),
    ).toBe(77 * CENT);
    // An exact conversion stays as is.
    expect(
      shopSellingPrice(
        50 * CENT,
        NO_SELLING_SETTINGS,
        { currency: 'syp', amountUnits: 13_000 * 100 },
        '13000.0000',
      ),
    ).toBe(USD);
  });

  it('has no price for an own SYP price without a rate (edge case 9)', () => {
    expect(
      shopSellingPrice(USD, NO_SELLING_SETTINGS, { currency: 'syp', amountUnits: 100 }, null),
    ).toBeNull();
  });

  it('marks the purchase price up, rounded up to whole cents', () => {
    // $1.01 × 1.10 = $1.111 → $1.12.
    expect(shopSellingPrice(101 * CENT, { markupBp: 1_000, sypStepUnits: null }, null, null)).toBe(
      112 * CENT,
    );
  });

  it('sells at the purchase price without a markup or own price', () => {
    expect(shopSellingPrice(3 * USD, NO_SELLING_SETTINGS, null, '13000.0000')).toBe(3 * USD);
  });
});

describe('shopSellingSyp (ST4)', () => {
  it('shows an own SYP price as set', () => {
    expect(shopSellingSyp(USD, { currency: 'syp', amountUnits: 12_345 * 100 }, null, 500)).toBe(
      12_345 * 100,
    );
  });

  it('converts USD at the rate, rounded up to the step', () => {
    // $1.00 at 13,010 = 13,010 SYP → the 50-pound step gives 13,050.
    expect(shopSellingSyp(USD, null, '13010.0000', 5_000)).toBe(13_050 * 100);
  });

  it('shows no SYP without a rate', () => {
    expect(shopSellingSyp(USD, { currency: 'usd', amountUnits: USD }, null, 500)).toBeNull();
  });
});

describe('shopPackSellable (PR3)', () => {
  it('sells at or above the purchase price only', () => {
    expect(shopPackSellable(USD, USD)).toBe(true);
    expect(shopPackSellable(USD + CENT, USD)).toBe(true);
    expect(shopPackSellable(USD - CENT, USD)).toBe(false);
    expect(shopPackSellable(null, USD)).toBe(false);
  });
});

describe('shopOrderAmounts (PR6, PR8)', () => {
  it('splits the selling total into the purchase price and the margin', () => {
    expect(shopOrderAmounts(120 * CENT, USD, 3)).toEqual({
      sellUsdUnits: 360 * CENT,
      buyUsdUnits: 3 * USD,
      marginUsdUnits: 60 * CENT,
    });
  });

  it('has a zero margin at the purchase price', () => {
    expect(shopOrderAmounts(USD, USD, 2).marginUsdUnits).toBe(0);
  });

  it('refuses a price below cost', () => {
    expect(() => shopOrderAmounts(USD - CENT, USD, 1)).toThrow(RangeError);
  });
});

describe('shop compensation (PR10)', () => {
  const finishedAt = new Date('2026-11-01T10:00:00Z');
  const order = { shopOrder: true, finishedAt, deliveredQuantity: 3, compensatedQuantity: 1 };

  it('allows the delivered units not yet compensated within 7 days', () => {
    expect(shopCompensationRefusal(order, 2, new Date('2026-11-02T10:00:00Z'))).toBeNull();
    const last = new Date(finishedAt.getTime() + SHOP_COMPENSATION_WINDOW_DAYS * 24 * HOUR);
    expect(shopCompensationRefusal(order, 1, last)).toBeNull();
  });

  it('names why it refuses', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    expect(shopCompensationRefusal({ ...order, shopOrder: false }, 1, now)).toBe('not_shop_order');
    expect(shopCompensationRefusal({ ...order, finishedAt: null }, 1, now)).toBe('not_finished');
    expect(shopCompensationRefusal({ ...order, deliveredQuantity: 0 }, 1, now)).toBe(
      'not_finished',
    );
    expect(shopCompensationRefusal(order, 1, new Date('2026-11-08T10:00:01Z'))).toBe(
      'window_closed',
    );
    expect(shopCompensationRefusal(order, 3, now)).toBe('units');
  });

  it('owes the margin back only when it was released', () => {
    expect(shopCompensationAmounts(150 * CENT, USD, 2, true)).toEqual({
      vertexUsdUnits: 2 * USD,
      marginUsdUnits: USD,
    });
    expect(shopCompensationAmounts(150 * CENT, USD, 2, false)).toEqual({
      vertexUsdUnits: 2 * USD,
      marginUsdUnits: 0,
    });
  });
});

describe('shopTicketCustomerMayEscalate (TK2)', () => {
  const asked = new Date('2026-11-10T08:00:00Z');
  const ticket = {
    status: 'open',
    escalatedAt: null,
    lastCustomerMessageAt: asked,
    lastMerchantMessageAt: null,
  };
  const later = (hours: number) => new Date(asked.getTime() + hours * HOUR);

  it('opens after 24 hours without a merchant reply', () => {
    expect(shopTicketCustomerMayEscalate(ticket, later(23.9))).toBe(false);
    expect(shopTicketCustomerMayEscalate(ticket, later(24))).toBe(true);
    // A reply older than the customer's last message does not count.
    expect(
      shopTicketCustomerMayEscalate({ ...ticket, lastMerchantMessageAt: later(-1) }, later(25)),
    ).toBe(true);
  });

  it('stays closed after a merchant reply, on an escalated or closed ticket, or with no message', () => {
    expect(
      shopTicketCustomerMayEscalate({ ...ticket, lastMerchantMessageAt: later(1) }, later(30)),
    ).toBe(false);
    expect(shopTicketCustomerMayEscalate({ ...ticket, escalatedAt: later(2) }, later(30))).toBe(
      false,
    );
    expect(shopTicketCustomerMayEscalate({ ...ticket, status: 'closed' }, later(30))).toBe(false);
    expect(
      shopTicketCustomerMayEscalate({ ...ticket, lastCustomerMessageAt: null }, later(30)),
    ).toBe(false);
  });
});

describe('shopReturnsAlarming (abuse)', () => {
  it('alerts above half of the transfers with at least $200 returned', () => {
    const floor = SHOP_RETURN_ALERT_MIN_USD_UNITS;
    expect(shopReturnsAlarming({ transferredUsdUnits: 300 * USD, returnedUsdUnits: floor })).toBe(
      true,
    );
    expect(shopReturnsAlarming({ transferredUsdUnits: 2 * floor, returnedUsdUnits: floor })).toBe(
      false,
    );
    expect(
      shopReturnsAlarming({ transferredUsdUnits: 100 * USD, returnedUsdUnits: floor - CENT }),
    ).toBe(false);
  });
});

describe('isBotUserAgent (SP3)', () => {
  it('leaves bots, previews and a missing agent out', () => {
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBotUserAgent('WhatsApp/2.23.20.0')).toBe(true);
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe(false);
  });
});

describe('shop shapes (PR4)', () => {
  const keysDeep = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(keysDeep);
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
    }
    return [];
  };
  const forbidden = /purchase|buy|cost|margin|priceList|retail|^priceUsdUnits$|savings/i;

  it('never carries a purchase price, a margin, a list or a retail price', () => {
    for (const schema of [shopStorefrontSchema, shopGameSchema, shopOrderSchema]) {
      const shape = schema.toJSONSchema({ unrepresentable: 'any' });
      const offenders = keysDeep(shape.properties ?? {}).filter((key) => forbidden.test(key));
      expect(offenders).toEqual([]);
    }
  });

  it('asks for the selling price the page showed', () => {
    const parsed = shopPurchaseSchema.parse({
      productId: '019a0000-0000-7000-8000-000000000001',
      quantity: 1,
      expectedUnitSellUsdUnits: 120 * CENT,
    });
    expect(parsed).toMatchObject({ fields: {}, confirmPlayer: false });
    expect(
      shopPurchaseSchema.safeParse({ ...parsed, expectedUnitSellUsdUnits: 120 * CENT + 1 }).success,
    ).toBe(false);
  });

  it('reads the icon size', () => {
    expect(shopIconQuerySchema.parse({ size: '512' })).toEqual({ size: 512 });
    expect(shopIconQuerySchema.safeParse({ size: '100' }).success).toBe(false);
  });
});

describe('the shop cache tag (store revalidation)', () => {
  it('accepts the store tags and a shop tag only', () => {
    const shopId = '019a0000-0000-7000-8000-000000000001';
    expect(shopCacheTag(shopId)).toBe(`shop:${shopId}`);
    expect(storeCacheTag('catalog')).toBe('catalog');
    expect(storeCacheTag('content')).toBe('content');
    expect(storeCacheTag(`shop:${shopId}`)).toBe(`shop:${shopId}`);
    expect(storeCacheTag('shop:nope')).toBeUndefined();
    expect(storeCacheTag(42)).toBeUndefined();
  });
});
