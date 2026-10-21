import { describe, expect, it } from 'vitest';
import { QUICK_CODE_ALPHABET, quickCampaign, type SearchIndex } from './catalog.js';
import { REFERENCE_CODE_ALPHABET } from './deposits.js';
import { sypDepositUsd, USD_CENT } from './money.js';
import { updateSavedPlayerSchema } from './orders.js';
import {
  type BestValuePack,
  bestValue,
  depositGap,
  gapDepositAmount,
  parseSearchCommand,
  quickLinkStatsQuerySchema,
} from './quick-buy.js';

const usd = (dollars: number) => Math.round(dollars * 100) * USD_CENT;

describe('quick links', () => {
  it('codes use the order-number alphabet', () => {
    expect(QUICK_CODE_ALPHABET).toBe(REFERENCE_CODE_ALPHABET);
  });

  it('keeps a campaign only when it matches the pattern (DL1)', () => {
    expect(quickCampaign('whatsapp')).toBe('whatsapp');
    expect(quickCampaign('shop_1-a')).toBe('shop_1-a');
    expect(quickCampaign('WhatsApp')).toBeNull();
    expect(quickCampaign('a'.repeat(33))).toBeNull();
    expect(quickCampaign('')).toBeNull();
    expect(quickCampaign(['x'])).toBeNull();
    expect(quickCampaign(undefined)).toBeNull();
  });

  it('accepts a stats range within 90 days', () => {
    const range = (from: string, to: string) =>
      quickLinkStatsQuerySchema.safeParse({ from, to }).success;
    expect(range('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(true);
    expect(range('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(false);
    expect(range('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(false);
  });
});

describe('updateSavedPlayerSchema (QB5)', () => {
  it('takes a label, the quick-buy switch, or both, never nothing', () => {
    expect(updateSavedPlayerSchema.safeParse({ quickBuyHidden: true }).success).toBe(true);
    expect(updateSavedPlayerSchema.safeParse({ label: 'أخي' }).success).toBe(true);
    expect(updateSavedPlayerSchema.safeParse({}).success).toBe(false);
  });
});

describe('depositGap (BG1)', () => {
  it('counts the open reservations and rounds up to whole cents', () => {
    expect(
      depositGap({ totalUsdUnits: usd(3.5), balanceUsdUnits: usd(1), reservedUsdUnits: 0 }),
    ).toBe(usd(2.5));
    expect(
      depositGap({ totalUsdUnits: usd(3.5), balanceUsdUnits: usd(5), reservedUsdUnits: usd(2) }),
    ).toBe(usd(0.5));
    expect(depositGap({ totalUsdUnits: usd(1), balanceUsdUnits: 1, reservedUsdUnits: 0 })).toBe(
      usd(1),
    );
    expect(
      depositGap({ totalUsdUnits: usd(1), balanceUsdUnits: usd(1), reservedUsdUnits: 0 }),
    ).toBe(0);
    expect(
      depositGap({ totalUsdUnits: usd(1), balanceUsdUnits: usd(9), reservedUsdUnits: 0 }),
    ).toBe(0);
  });
});

describe('gapDepositAmount (BG3)', () => {
  const limits = {
    minUnits: usd(5),
    perDepositMaxUnits: usd(500),
    remainingUnits: usd(1000),
    rate: '14650.5',
    stepSypUnits: 500,
  };

  it('raises a small gap to the method minimum', () => {
    expect(gapDepositAmount(usd(0.4), 'USD', limits)).toEqual({
      usdUnits: usd(5),
      sypUnits: null,
      raisedToMinimum: true,
      short: false,
    });
    expect(gapDepositAmount(usd(12.34), 'USD', limits)).toEqual({
      usdUnits: usd(12.34),
      sypUnits: null,
      raisedToMinimum: false,
      short: false,
    });
  });

  it('holds the cap when a limit is below the gap', () => {
    expect(gapDepositAmount(usd(800), 'USD', limits)).toMatchObject({
      usdUnits: usd(500),
      short: true,
    });
    expect(
      gapDepositAmount(usd(80), 'USD', { ...limits, remainingUnits: usd(30) + 5 }),
    ).toMatchObject({ usdUnits: usd(30), short: true });
  });

  it('rounds SYP up to the step and never credits less than the amount', () => {
    for (const rate of ['14650.5', '13000', '9999.99', '15123.456']) {
      for (const step of [100, 500, 5000]) {
        for (const cents of [500, 501, 999, 1234, 13_700, 49_999]) {
          const amount = gapDepositAmount(cents * USD_CENT, 'SYP', {
            ...limits,
            rate,
            stepSypUnits: step,
          });
          const syp = amount.sypUnits as number;
          expect(syp % step).toBe(0);
          expect(sypDepositUsd(syp, rate)).toBeGreaterThanOrEqual(amount.usdUnits);
          expect(sypDepositUsd(syp - step, rate)).toBeLessThan(amount.usdUnits);
        }
      }
    }
  });

  it('rounds a capped SYP amount down so it stays within the cap', () => {
    const amount = gapDepositAmount(usd(800), 'SYP', limits);
    expect(amount.short).toBe(true);
    expect(sypDepositUsd(amount.sypUnits as number, limits.rate)).toBeLessThanOrEqual(usd(500));
  });

  it('gives no pounds without a rate', () => {
    expect(gapDepositAmount(usd(7), 'SYP', { ...limits, rate: null }).sypUnits).toBeNull();
  });
});

describe('bestValue (BV1–BV3)', () => {
  const pack = (
    id: string,
    gameAmount: number | null,
    dollars: number,
    extra: Partial<BestValuePack> = {},
  ) =>
    ({
      id,
      kind: 'direct',
      gameAmount,
      available: true,
      priceUsdUnits: usd(dollars),
      ...extra,
    }) as BestValuePack;

  it('shows nothing with fewer than 3 considered packs or when switched off', () => {
    const packs = [
      pack('a', 60, 0.99),
      pack('b', 325, 4.99),
      pack('c', 660, 9.99, { available: false }),
      pack('d', 1800, 24.99, { kind: 'code' }),
      pack('e', 1, 0.1),
      pack('f', null, 3),
      pack('g', 8100, 99, { priceUsdUnits: null }),
    ];
    expect(bestValue(packs, true)).toEqual({ perHundredUsdUnits: {}, bestProductId: null });
    expect(
      bestValue([pack('a', 60, 0.99), pack('b', 325, 4.99), pack('c', 660, 9.99)], false),
    ).toEqual({ perHundredUsdUnits: {}, bestProductId: null });
  });

  it('prices per 100 rounded up and badges a 2% lead', () => {
    const result = bestValue(
      [pack('a', 60, 0.99), pack('b', 325, 4.99), pack('c', 660, 8.99), pack('d', 1800, 25)],
      true,
    );
    expect(result.perHundredUsdUnits).toEqual({
      a: usd(1.65),
      b: usd(1.54),
      c: usd(1.37),
      d: usd(1.39),
    });
    // 8.99/660 against 25/1800: 1.362 against 1.389, 1.94% lower: no badge.
    expect(result.bestProductId).toBeNull();
    expect(
      bestValue([pack('a', 60, 0.99), pack('c', 660, 8.99), pack('d', 1800, 26)], true)
        .bestProductId,
    ).toBe('c');
  });

  it('gives no badge on a tie and compares exactly at the 2% edge', () => {
    expect(
      bestValue([pack('a', 100, 1), pack('b', 200, 2), pack('c', 50, 3)], true).bestProductId,
    ).toBeNull();
    // 0.98 per unit against 1.00: exactly 2% lower.
    expect(
      bestValue([pack('a', 100, 0.98), pack('b', 100, 1), pack('c', 50, 3)], true).bestProductId,
    ).toBe('a');
    expect(
      bestValue([pack('a', 100, 0.99), pack('b', 100, 1), pack('c', 50, 3)], true).bestProductId,
    ).toBeNull();
  });
});

describe('parseSearchCommand (SC1–SC5)', () => {
  const game = (slug: string, nameAr: string, nameEn: string, searchTerms: string[] = []) => ({
    id: `00000000-0000-4000-8000-${slug.length.toString().padStart(12, '0')}`,
    slug,
    nameAr,
    nameEn,
    cover: null,
    status: 'normal' as const,
    searchTerms,
    categoryNameAr: 'ألعاب',
  });
  const product = (
    id: number,
    gameSlug: string,
    nameAr: string,
    gameAmount: number | null,
    available = true,
  ) => ({
    id: `00000000-0000-4000-8000-${id.toString().padStart(12, '0')}`,
    nameAr,
    gameAmount,
    available,
    priceUsdUnits: available ? usd(1) : null,
    priceSypUnits: null,
    gameSlug,
  });
  const index: SearchIndex = {
    games: [
      game('pubg-mobile', 'ببجي موبايل', 'PUBG Mobile', ['ببجي']),
      game('free-fire', 'فري فاير', 'Free Fire'),
    ],
    products: [
      product(1, 'pubg-mobile', '60 شدة', 60),
      product(2, 'pubg-mobile', '660 شدة', 660),
      product(3, 'pubg-mobile', '660 شدة عرض', 660),
      product(4, 'free-fire', '1,000 جوهرة', 1000),
      product(5, 'free-fire', 'عضوية 30 يوم', null),
      product(6, 'free-fire', '310 جوهرة', 310, false),
      product(7, 'pubg-mobile', '325 شدة', 325),
    ],
  };
  const players = [
    { id: 'p1', label: 'أخي', gameSlug: 'pubg-mobile' },
    { id: 'p2', label: 'أخي', gameSlug: 'free-fire' },
    { id: 'p3', label: 'أخي الكبير', gameSlug: 'pubg-mobile' },
    { id: 'p4', label: 'حسابي', gameSlug: 'free-fire' },
    { id: 'p5', label: '   ', gameSlug: 'free-fire' },
  ];
  const parse = (query: string, saved: typeof players | null = players) =>
    parseSearchCommand(query, index, saved).map((command) => [
      command.game.slug,
      command.product?.nameAr ?? null,
      command.savedPlayer?.id ?? null,
    ]);

  it('reads the amount in any digits, with separators', () => {
    expect(parse('٣٢٥ ببجي')).toEqual([['pubg-mobile', '325 شدة', null]]);
    expect(parse('1,000 فري فاير')).toEqual([['free-fire', '1,000 جوهرة', null]]);
    expect(parse('١٬٠٠٠')).toEqual([['free-fire', '1,000 جوهرة', null]]);
    expect(parse('۶۰')).toEqual([['pubg-mobile', '60 شدة', null]]);
  });

  it('matches a label with or without "لـ", the longest winning', () => {
    expect(parse('660 ببجي لأخي')).toEqual([
      ['pubg-mobile', '660 شدة', 'p1'],
      ['pubg-mobile', '660 شدة عرض', 'p1'],
    ]);
    expect(parse('60 لـ أخي')).toEqual([['pubg-mobile', '60 شدة', 'p1']]);
    expect(parse('60 الى أخي')).toEqual([['pubg-mobile', '60 شدة', 'p1']]);
    expect(parse('60 إلى أخي الكبير')).toEqual([['pubg-mobile', '60 شدة', 'p3']]);
    expect(parse('1000 حسابي')).toEqual([['free-fire', '1,000 جوهرة', 'p4']]);
    // A label that does not hold the game's pack gives nothing.
    expect(parse('1000 أخي الكبير')).toEqual([]);
  });

  it('gives one command per game for a label shared across games', () => {
    expect(parse('لأخي')).toEqual([
      ['pubg-mobile', null, 'p1'],
      ['free-fire', null, 'p2'],
    ]);
    expect(parse('أخي فري')).toEqual([['free-fire', null, 'p2']]);
  });

  it('falls back to names holding the number, available packs only', () => {
    expect(parse('30')).toEqual([['free-fire', 'عضوية 30 يوم', null]]);
    expect(parse('310')).toEqual([]);
    expect(parse('660 فري')).toEqual([]);
    expect(parse('60 كلاش')).toEqual([]);
  });

  it('ignores labels signed out, and queries without one amount', () => {
    expect(parse('660 لأخي', null)).toEqual([]);
    expect(parse('ببجي', null)).toEqual([]);
    expect(parse('60 660')).toEqual([]);
    expect(parse('0')).toEqual([]);
    expect(parse('2000000')).toEqual([]);
    expect(parse('   ')).toEqual([]);
  });

  it('lists at most 5 commands', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      product(100 + i, 'pubg-mobile', `pack ${i}`, 99),
    );
    expect(parseSearchCommand('99', { ...index, products: many }, null)).toHaveLength(5);
  });
});
