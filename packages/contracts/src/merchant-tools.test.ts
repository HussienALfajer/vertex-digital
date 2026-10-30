import { describe, expect, it } from 'vitest';
import {
  alertCounts,
  alertSettingsSchema,
  checkoutLinesMax,
  damascusMonth,
  levelFor,
  lowBalanceDue,
  markupPrice,
  merchantDashboardQuerySchema,
  merchantLevelInputSchema,
  monthRange,
  monthSchema,
  orderQuantityMax,
  PINNED_GAMES_MAX,
  pinnedGamesSchema,
  previousMonth,
  saleProfit,
  saleUnitUsd,
  savedPlayerLimits,
  sellingPrice,
  sellingPriceInputSchema,
  sellingPriceTooHigh,
  sellingSettingsSchema,
  tierGrantEndsAt,
  updateReceiptSettingsSchema,
  updateWatchesSchema,
  watchChanges,
  YOUR_GAMES_SHOWN,
  yourGames,
} from './merchant-tools.js';

const ID = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const USD = 1_000_000;
const RATE = '13000';
const STORE_STEP = 500;

describe('sellingPrice (SP3)', () => {
  const none = { markupBp: null, sypStepUnits: null };

  it("takes the product's USD price, its SYP at the step rounded up", () => {
    expect(
      sellingPrice(USD, none, { currency: 'usd', amountUnits: 1_230_000 }, '13001', STORE_STEP),
    ).toEqual({ usdUnits: 1_230_000, sypUnits: 1_599_500, source: 'product' });
    expect(
      sellingPrice(USD, none, { currency: 'usd', amountUnits: USD }, null, STORE_STEP),
    ).toEqual({ usdUnits: USD, sypUnits: null, source: 'product' });
  });

  it('keeps a SYP price as set and its USD equivalent rounded down (decision 1)', () => {
    expect(
      sellingPrice(USD, none, { currency: 'syp', amountUnits: 1_500_000 }, RATE, STORE_STEP),
    ).toEqual({ usdUnits: 1_150_000, sypUnits: 1_500_000, source: 'product' });
    expect(
      sellingPrice(USD, none, { currency: 'syp', amountUnits: 1_500_000 }, null, STORE_STEP),
    ).toBeNull();
  });

  it('adds the markup over the purchase price, rounded up to cents and the chosen step', () => {
    expect(
      sellingPrice(1_000_100, { markupBp: 1_000, sypStepUnits: 100_000 }, null, RATE, STORE_STEP),
    ).toEqual({ usdUnits: 1_110_000, sypUnits: 1_500_000, source: 'markup' });
    expect(sellingPrice(USD, { markupBp: 0, sypStepUnits: null }, null, RATE, STORE_STEP)).toEqual({
      usdUnits: USD,
      sypUnits: 1_300_000,
      source: 'markup',
    });
  });

  it('has none without a markup or a purchase price', () => {
    expect(sellingPrice(USD, none, null, RATE, STORE_STEP)).toBeNull();
    expect(
      sellingPrice(null, { markupBp: 500, sypStepUnits: null }, null, RATE, STORE_STEP),
    ).toBeNull();
  });

  it('refuses a markup beyond the safe range', () => {
    expect(() => markupPrice(Number.MAX_SAFE_INTEGER, 10_000)).toThrow(RangeError);
  });
});

describe('selling price inputs (SP1, SP2)', () => {
  it('accept whole cents in USD and whole pounds in SYP', () => {
    const parse = (body: object) => sellingPriceInputSchema.safeParse(body).success;
    expect(parse({ currency: 'usd', amountUnits: 1_230_000 })).toBe(true);
    expect(parse({ currency: 'usd', amountUnits: 1_230_001 })).toBe(false);
    expect(parse({ currency: 'usd', amountUnits: 10_001 * USD })).toBe(false);
    expect(parse({ currency: 'syp', amountUnits: 1_500_000 })).toBe(true);
    expect(parse({ currency: 'syp', amountUnits: 1_500_050 })).toBe(false);
    expect(parse({ currency: 'eur', amountUnits: 100 })).toBe(false);
  });

  it('caps a SYP price at $10,000 at the rate', () => {
    expect(sellingPriceTooHigh({ currency: 'usd', amountUnits: 10_000 * USD }, RATE)).toBe(false);
    expect(sellingPriceTooHigh({ currency: 'syp', amountUnits: 13_000_000_000 }, RATE)).toBe(false);
    expect(sellingPriceTooHigh({ currency: 'syp', amountUnits: 13_000_000_100 }, RATE)).toBe(true);
  });

  it('take a markup of 0–100% and a listed step', () => {
    const parse = (body: object) => sellingSettingsSchema.safeParse(body).success;
    expect(parse({ markupBp: 1_000, sypStepUnits: 500 })).toBe(true);
    expect(parse({ markupBp: null, sypStepUnits: null })).toBe(true);
    expect(parse({ markupBp: 10_001, sypStepUnits: null })).toBe(false);
    expect(parse({ markupBp: 0, sypStepUnits: 700 })).toBe(false);
  });
});

describe('sales and profit (SP4–SP6)', () => {
  it('converts a SYP sale at the rate, rounded down to cents', () => {
    expect(saleUnitUsd('usd', 1_230_000, RATE)).toBe(1_230_000);
    expect(saleUnitUsd('syp', 1_500_000, RATE)).toBe(1_150_000);
  });

  it('counts delivered units only, and may be a loss', () => {
    expect(
      saleProfit({ deliveredQuantity: 3, unitPriceUsdUnits: USD }, { unitUsdUnits: 1_200_000 }),
    ).toBe(600_000);
    expect(
      saleProfit({ deliveredQuantity: 2, unitPriceUsdUnits: USD }, { unitUsdUnits: 900_000 }),
    ).toBe(-200_000);
    expect(saleProfit({ deliveredQuantity: 0, unitPriceUsdUnits: USD }, { unitUsdUnits: 1 })).toBe(
      0,
    );
    expect(saleProfit({ deliveredQuantity: 3, unitPriceUsdUnits: USD }, null)).toBeNull();
  });
});

describe('Damascus months', () => {
  it('names the month of an instant in Damascus', () => {
    // 2026-10-31 22:30 UTC is 2026-11-01 01:30 in Damascus (UTC+3).
    expect(damascusMonth(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11');
    expect(damascusMonth(new Date('2026-10-31T20:00:00Z'))).toBe('2026-10');
  });

  it('bounds a month, December into January', () => {
    expect(monthRange('2026-10')).toEqual({
      start: new Date('2026-09-30T21:00:00Z'),
      end: new Date('2026-10-31T21:00:00Z'),
    });
    expect(monthRange('2026-12').end).toEqual(new Date('2026-12-31T21:00:00Z'));
    expect(previousMonth('2027-01')).toBe('2026-12');
    expect(monthSchema.safeParse('2026-13').success).toBe(false);
    expect(monthSchema.safeParse('2026-09').success).toBe(true);
  });
});

describe('tierGrantEndsAt (S23 MG1)', () => {
  // 10:00 in Damascus (UTC+3) on 2026-10-29.
  const now = new Date('2026-10-29T07:00:00Z');

  it('ends at the end of the chosen Damascus day, 1 to 90 days ahead', () => {
    expect(tierGrantEndsAt('2026-10-30', now)?.toISOString()).toBe('2026-10-30T21:00:00.000Z');
    expect(tierGrantEndsAt('2027-01-27', now)?.toISOString()).toBe('2027-01-27T21:00:00.000Z');
  });

  it('refuses today, the past and beyond 90 days', () => {
    expect(tierGrantEndsAt('2026-10-29', now)).toBeNull();
    expect(tierGrantEndsAt('2026-10-01', now)).toBeNull();
    expect(tierGrantEndsAt('2027-01-28', now)).toBeNull();
  });
});

describe('levelFor (LV3)', () => {
  const levels = [
    { id: 'silver', monthlyThresholdUsdUnits: 50 * USD },
    { id: 'gold', monthlyThresholdUsdUnits: 200 * USD },
  ];

  it('is null without levels or below every threshold', () => {
    expect(levelFor([], 1_000 * USD, 0)).toBeNull();
    expect(levelFor(levels, 49 * USD, 10 * USD)).toBeNull();
  });

  it('takes the highest level reached by the larger month, a tie included', () => {
    expect(levelFor(levels, 50 * USD, 0)?.id).toBe('silver');
    expect(levelFor(levels, 10 * USD, 250 * USD)?.id).toBe('gold');
    expect(levelFor([...levels].reverse(), 300 * USD, 0)?.id).toBe('gold');
    expect(levelFor(levels, -5 * USD, 60 * USD)?.id).toBe('silver');
  });

  it('takes whole-dollar thresholds of at least $1', () => {
    const parse = (body: object) => merchantLevelInputSchema.safeParse(body).success;
    const level = { nameAr: ' فضي ', monthlyThresholdUsdUnits: 50 * USD, priceListId: ID };
    expect(parse(level)).toBe(true);
    expect(parse({ ...level, monthlyThresholdUsdUnits: 50 * USD + 10_000 })).toBe(false);
    expect(parse({ ...level, monthlyThresholdUsdUnits: 0 })).toBe(false);
    expect(parse({ ...level, nameAr: 'ف' })).toBe(false);
  });
});

describe('dashboard query (DB1)', () => {
  it('defaults to today', () => {
    expect(merchantDashboardQuerySchema.parse({})).toEqual({ period: 'today' });
    expect(merchantDashboardQuerySchema.safeParse({ period: 'year' }).success).toBe(false);
  });
});

describe('alerts (AL1–AL6)', () => {
  it('finds price and availability changes (AL2)', () => {
    const told = { priceUsdUnits: USD, available: true };
    expect(watchChanges(told, told)).toEqual([]);
    expect(watchChanges(told, { priceUsdUnits: 900_000, available: true })).toEqual(['price_down']);
    expect(watchChanges(told, { priceUsdUnits: 1_100_000, available: false })).toEqual([
      'price_up',
      'out_of_stock',
    ]);
    expect(
      watchChanges(
        { priceUsdUnits: null, available: false },
        { priceUsdUnits: USD, available: true },
      ),
    ).toEqual(['back_in_stock']);
    expect(watchChanges(told, { priceUsdUnits: null, available: true })).toEqual([]);
  });

  it('counts a digest (AL3)', () => {
    expect(alertCounts(['price_down', 'price_down', 'back_in_stock'])).toEqual({
      price_down: 2,
      price_up: 0,
      back_in_stock: 1,
      out_of_stock: 0,
    });
  });

  it('sends the low-balance alert once below the threshold (AL5)', () => {
    expect(lowBalanceDue(5 * USD, { lowBalanceUsdUnits: 10 * USD, alerted: false })).toBe(true);
    expect(lowBalanceDue(5 * USD, { lowBalanceUsdUnits: 10 * USD, alerted: true })).toBe(false);
    expect(lowBalanceDue(10 * USD, { lowBalanceUsdUnits: 10 * USD, alerted: false })).toBe(false);
    expect(lowBalanceDue(5 * USD, { lowBalanceUsdUnits: null, alerted: false })).toBe(false);
  });

  it('takes a threshold of $1–$10,000 in cents', () => {
    const parse = (value: number | null) =>
      alertSettingsSchema.safeParse({ lowBalanceUsdUnits: value, dailyEmail: false }).success;
    expect(parse(null)).toBe(true);
    expect(parse(25 * USD)).toBe(true);
    expect(parse(500_000)).toBe(false);
    expect(parse(10_001 * USD)).toBe(false);
  });

  it('refuses duplicate follows', () => {
    const parse = (body: object) => updateWatchesSchema.safeParse(body).success;
    expect(parse({ gameIds: [ID], productIds: [OTHER] })).toBe(true);
    expect(parse({ gameIds: [ID, ID], productIds: [] })).toBe(false);
    expect(parse({ gameIds: [], productIds: [OTHER, OTHER] })).toBe(false);
  });
});

describe('counter limits (QT1, QT2, decision 10, BK3)', () => {
  const gold = { orderUnitsMax: 100, bulkLinesMax: 100 };

  it("lets a merchant buy their tier's codes, keeps the pack limit otherwise (TS5)", () => {
    expect(orderQuantityMax({ kind: 'code', maxQuantity: 5 }, 'merchant', null)).toBe(50);
    expect(orderQuantityMax({ kind: 'code', maxQuantity: 5 }, 'merchant', gold)).toBe(100);
    expect(orderQuantityMax({ kind: 'code', maxQuantity: 5 }, 'customer', null)).toBe(5);
    expect(orderQuantityMax({ kind: 'direct', maxQuantity: 3 }, 'merchant', gold)).toBe(3);
  });

  it('raises saved ids and checkout lines for merchants only', () => {
    expect(savedPlayerLimits('merchant')).toEqual({ perGame: 50, total: 300 });
    expect(savedPlayerLimits('customer')).toEqual({ perGame: 10, total: 50 });
    expect(checkoutLinesMax('merchant', null)).toBe(50);
    expect(checkoutLinesMax('merchant', gold)).toBe(100);
    expect(checkoutLinesMax('customer', null)).toBe(10);
  });
});

describe('pinned games, "ألعابك" (owner, 2026-10-30)', () => {
  const game = (id: string, recentUnits = 0) => ({ id, recentUnits });
  const ids = Array.from({ length: 14 }, (_, index) => `g${index}`);

  it('takes up to 20 distinct games', () => {
    expect(pinnedGamesSchema.safeParse({ gameIds: [ID, OTHER] }).success).toBe(true);
    expect(pinnedGamesSchema.safeParse({ gameIds: [ID, ID] }).success).toBe(false);
    const many = Array.from(
      { length: PINNED_GAMES_MAX + 1 },
      (_, index) => `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(pinnedGamesSchema.safeParse({ gameIds: many.slice(0, PINNED_GAMES_MAX) }).success).toBe(
      true,
    );
    expect(pinnedGamesSchema.safeParse({ gameIds: many }).success).toBe(false);
  });

  it('puts the pinned games first in their order, then followed, then bought lately', () => {
    const games = [game('a'), game('b', 3), game('c', 9), game('d'), game('e', 1)];
    expect(
      yourGames(games, ['d', 'gone', 'a'], new Set(['e'])).map(
        ({ game: shown, source }) => `${shown.id}:${source}`,
      ),
    ).toEqual(['d:pinned', 'a:pinned', 'e:suggested', 'c:suggested', 'b:suggested']);
  });

  it('fills up to 10 only, and suggests nothing once 10 are pinned', () => {
    const games = ids.map((id) => game(id, 1));
    expect(yourGames(games, ['g0'], new Set())).toHaveLength(YOUR_GAMES_SHOWN);
    const pinned = ids.slice(0, 12);
    const shown = yourGames(games, pinned, new Set());
    expect(shown).toHaveLength(12);
    expect(shown.every((entry) => entry.source === 'pinned')).toBe(true);
    expect(yourGames([game('x')], [], new Set())).toEqual([]);
  });
});

describe('receipt settings (BR3)', () => {
  it('needs a number to show and normalizes it', () => {
    const shown = { showWhatsapp: true, logoFileId: null, welcomeText: null };
    expect(updateReceiptSettingsSchema.safeParse({ ...shown, whatsapp: null }).success).toBe(false);
    expect(updateReceiptSettingsSchema.parse({ ...shown, whatsapp: '0933 123 456' }).whatsapp).toBe(
      '+963933123456',
    );
    expect(
      updateReceiptSettingsSchema.safeParse({
        showWhatsapp: false,
        whatsapp: null,
        logoFileId: ID,
        welcomeText: null,
      }).success,
    ).toBe(true);
  });
});
