import { describe, expect, it } from 'vitest';
import {
  merchantPriceListQuerySchema,
  priceListLine,
  priceListPage,
  priceListPages,
  statementBalances,
  statementMonths,
  statementSales,
  statementTotals,
} from './merchant-documents.js';

const ID = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const USD = 1_000_000;
const RATE = '13000';
const STORE_STEP = 500;

describe('price list (PL1–PL3)', () => {
  const row = {
    available: true,
    purchaseUsdUnits: USD,
    sellingUsdUnits: 1_200_000,
    sellingSypUnits: 15_600_000,
  };
  const selling = { mode: 'selling', unavailable: false } as const;

  it('takes the defaults and comma-separated games', () => {
    expect(merchantPriceListQuerySchema.parse({})).toEqual({
      mode: 'selling',
      currency: 'syp',
      unavailable: false,
      page: 1,
    });
    expect(
      merchantPriceListQuerySchema.parse({
        gameIds: `${ID},${OTHER},`,
        unavailable: 'true',
        page: '2',
      }),
    ).toMatchObject({ gameIds: [ID, OTHER], unavailable: true, page: 2 });
    expect(merchantPriceListQuerySchema.parse({ gameIds: [ID] }).gameIds).toEqual([ID]);
    expect(merchantPriceListQuerySchema.safeParse({ gameIds: 'x' }).success).toBe(false);
    expect(merchantPriceListQuerySchema.safeParse({ mode: 'cost' }).success).toBe(false);
  });

  it('prints the selling price, or omits a pack without one (PL2)', () => {
    expect(priceListLine(row, selling, RATE, STORE_STEP)).toEqual({
      kind: 'price',
      usdUnits: 1_200_000,
      sypUnits: 15_600_000,
    });
    expect(
      priceListLine(
        { ...row, sellingUsdUnits: null, sellingSypUnits: null },
        selling,
        RATE,
        STORE_STEP,
      ),
    ).toEqual({ kind: 'omitted' });
  });

  it('prints the purchase price at the store rounding, without SYP when there is no rate', () => {
    const purchase = { mode: 'purchase', unavailable: false } as const;
    expect(priceListLine(row, purchase, RATE, STORE_STEP)).toEqual({
      kind: 'price',
      usdUnits: USD,
      sypUnits: 1_300_000,
    });
    expect(priceListLine(row, purchase, null, STORE_STEP)).toEqual({
      kind: 'price',
      usdUnits: USD,
      sypUnits: null,
    });
  });

  it('lists an unavailable pack only when asked', () => {
    const off = { ...row, available: false, purchaseUsdUnits: null };
    expect(priceListLine(off, selling, RATE, STORE_STEP)).toEqual({ kind: 'hidden' });
    expect(priceListLine(off, { ...selling, unavailable: true }, RATE, STORE_STEP)).toEqual({
      kind: 'unavailable',
    });
  });

  it('cuts the packs into images of 60 under their games (PL3)', () => {
    const rows = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({
        productId: ID,
        nameAr: `${prefix}${index}`,
        available: true,
        usdUnits: USD,
        sypUnits: null,
      }));
    const games = [
      { gameId: ID, nameAr: 'A', rows: rows(50, 'a') },
      { gameId: OTHER, nameAr: 'B', rows: rows(30, 'b') },
    ];
    expect(priceListPages(games)).toBe(2);
    expect(priceListPages([])).toBe(1);
    const first = priceListPage(games, 1);
    expect(first.map((game) => [game.nameAr, game.rows.length])).toEqual([
      ['A', 50],
      ['B', 10],
    ]);
    const second = priceListPage(games, 2);
    expect(second.map((game) => [game.nameAr, game.rows.length])).toEqual([['B', 20]]);
    expect(second[0]?.rows[0]?.nameAr).toBe('b10');
    expect(priceListPage(games, 3)).toEqual([]);
  });
});

describe('statement (ST1, ST2)', () => {
  it('lists the Damascus months from the account to now, newest first', () => {
    expect(
      statementMonths(new Date('2026-08-31T21:30:00Z'), new Date('2026-10-21T10:00:00Z')),
    ).toEqual(['2026-10', '2026-09']);
    expect(
      statementMonths(new Date('2025-12-15T10:00:00Z'), new Date('2026-01-02T10:00:00Z')),
    ).toEqual(['2026-01', '2025-12']);
  });

  it('totals per kind in the kinds order and checks the balance equation', () => {
    const entries = [
      { kind: 'purchase', amountUnits: -2 * USD },
      { kind: 'deposit', amountUnits: 10 * USD },
      { kind: 'purchase', amountUnits: -USD },
      { kind: 'refund', amountUnits: USD },
    ] as const;
    expect(statementTotals(entries)).toEqual([
      { kind: 'deposit', count: 1, amountUnits: 10 * USD },
      { kind: 'purchase', count: 2, amountUnits: -3 * USD },
      { kind: 'refund', count: 1, amountUnits: USD },
    ]);
    expect(statementTotals([])).toEqual([]);
    expect(statementBalances(USD, entries, 9 * USD)).toBe(true);
    expect(statementBalances(USD, entries, 8 * USD)).toBe(false);
  });
});

describe("the statement screen's sales (owner, 2026-10-30)", () => {
  it('derives the cost from the sales and the estimated profit, in integer units', () => {
    expect(
      statementSales({ salesUsdUnits: 5_080_000, profitUsdUnits: 470_000, ordersWithoutSale: 2 }),
    ).toEqual({
      salesUsdUnits: 5_080_000,
      costUsdUnits: 4_610_000,
      profitUsdUnits: 470_000,
      ordersWithoutSale: 2,
    });
    // Sold below cost: a negative profit, a cost above the sales.
    expect(
      statementSales({ salesUsdUnits: 900_000, profitUsdUnits: -100_000, ordersWithoutSale: 0 })
        .costUsdUnits,
    ).toBe(1_000_000);
  });
});
