import { describe, expect, it } from 'vitest';
import {
  alertCounts,
  alertSettingsSchema,
  bulkCheckRequestSchema,
  bulkNeedsConfirmation,
  checkoutLinesMax,
  damascusMonth,
  levelFor,
  lowBalanceDue,
  markupPrice,
  merchantDashboardQuerySchema,
  merchantLevelInputSchema,
  monthRange,
  monthSchema,
  nextLevel,
  orderQuantityMax,
  parseBulkLines,
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

  it('names the next level and the amount missing (DB5)', () => {
    expect(nextLevel(levels, 30 * USD)).toEqual({ level: levels[0], missingUsdUnits: 20 * USD });
    expect(nextLevel([...levels].reverse(), 60 * USD)?.level.id).toBe('gold');
    expect(nextLevel(levels, -10 * USD)?.missingUsdUnits).toBe(50 * USD);
    expect(nextLevel(levels, 200 * USD)).toBeNull();
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

describe('parseBulkLines (BK1)', () => {
  const game = {
    fieldKeys: ['player_id'],
    packs: [
      { id: ID, nameAr: '60 شدة', gameAmount: 60 },
      { id: OTHER, nameAr: '325 شدة', gameAmount: 325 },
    ],
  };

  it('reads commas, tabs and semicolons, a quantity, Arabic digits and the pack name', () => {
    const text = '﻿# player_id, pack, quantity\n5123,60\r\n5124\t325\t۳\n\n٥١٢٥;325 شدة;٢';
    expect(parseBulkLines(text, game)).toEqual([
      { line: 2, fields: { player_id: '5123' }, productId: ID, quantity: 1, errors: [] },
      { line: 3, fields: { player_id: '5124' }, productId: OTHER, quantity: 3, errors: [] },
      { line: 5, fields: { player_id: '٥١٢٥' }, productId: OTHER, quantity: 2, errors: [] },
    ]);
  });

  it('reads quoted cells, with doubled quotes and separators inside', () => {
    const twoFields = { fieldKeys: ['id', 'server'], packs: game.packs };
    const [line] = parseBulkLines('"51,23"," a ""b"" ",60', twoFields);
    expect(line).toMatchObject({ fields: { id: '51,23', server: 'a "b"' }, productId: ID });
  });

  it('reports columns, unknown and ambiguous packs and bad quantities per line', () => {
    const twins = {
      fieldKeys: ['player_id'],
      packs: [...game.packs, { id: OTHER, nameAr: 'أخرى', gameAmount: 60 }],
    };
    expect(
      parseBulkLines('1\n1,2,3,4\n1,999\n1,60,0\n1,60,x\n1,60,101', game).map((l) => l.errors),
    ).toEqual([
      ['columns'],
      ['columns'],
      ['pack_unknown'],
      ['quantity_invalid'],
      ['quantity_invalid'],
      ['quantity_invalid'],
    ]);
    expect(parseBulkLines('1,60', twins)[0]?.errors).toEqual(['pack_ambiguous']);
  });

  it('takes 1–100 KB of text', () => {
    expect(bulkCheckRequestSchema.safeParse({ gameId: ID, text: 'a' }).success).toBe(true);
    expect(bulkCheckRequestSchema.safeParse({ gameId: ID, text: '' }).success).toBe(false);
    const big = 'ش'.repeat(51 * 1024);
    expect(bulkCheckRequestSchema.safeParse({ gameId: ID, text: big }).success).toBe(false);
  });

  it('asks a confirmation unless the id is known valid or never checked (BK3)', () => {
    expect(bulkNeedsConfirmation(null)).toBe(false);
    expect(bulkNeedsConfirmation({ result: 'valid', playerName: null, region: null })).toBe(false);
    expect(bulkNeedsConfirmation({ result: 'not_supported' })).toBe(false);
    expect(bulkNeedsConfirmation({ result: 'invalid' })).toBe(true);
    expect(bulkNeedsConfirmation({ result: 'unavailable', reason: 'quota' })).toBe(true);
  });
});

describe('receipt settings (BR3)', () => {
  it('needs a number to show and normalizes it', () => {
    const shown = { showWhatsapp: true, logoFileId: null };
    expect(updateReceiptSettingsSchema.safeParse({ ...shown, whatsapp: null }).success).toBe(false);
    expect(updateReceiptSettingsSchema.parse({ ...shown, whatsapp: '0933 123 456' }).whatsapp).toBe(
      '+963933123456',
    );
    expect(
      updateReceiptSettingsSchema.safeParse({ showWhatsapp: false, whatsapp: null, logoFileId: ID })
        .success,
    ).toBe(true);
  });
});
