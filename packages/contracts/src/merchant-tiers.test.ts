import { describe, expect, it } from 'vitest';
import {
  adminMerchantTierSchema,
  earnedTierFor,
  effectiveLevel,
  expectedParentListId,
  higherTier,
  isImportantTierChange,
  TIER_SETTINGS_DEFAULTS,
  TIER_THRESHOLD_DEFAULTS,
  type TierLevel,
  tierForecast,
  tierGrantInputSchema,
  tierKeptUntil,
  tierLevelInputSchema,
  tierOf,
  tierPreviewInputSchema,
  tierProgress,
  tierRank,
  tierReminder,
  tierSettingsInputSchema,
  tierThresholdsRise,
  welcomeTextSchema,
} from './merchant-tiers.js';

const USD = 1_000_000;

const levels: TierLevel[] = [
  { id: 'silver', tier: 'silver', monthlyThresholdUsdUnits: 300 * USD },
  { id: 'gold', tier: 'gold', monthlyThresholdUsdUnits: 1_000 * USD },
  { id: 'diamond', tier: 'diamond', monthlyThresholdUsdUnits: 3_000 * USD },
];
const [silver, gold] = levels as [TierLevel, TierLevel, TierLevel];

describe('tier order (TR1)', () => {
  it('ranks Bronze to Diamond and picks the higher', () => {
    expect(['bronze', 'silver', 'gold', 'diamond'].map((tier) => tierRank(tier as never))).toEqual([
      0, 1, 2, 3,
    ]);
    expect(higherTier('gold', 'silver')).toBe('gold');
    expect(higherTier('silver', 'diamond')).toBe('diamond');
    expect(tierOf(null)).toBe('bronze');
    expect(tierOf(gold)).toBe('gold');
  });

  it('names the important changes: into or out of Gold or Diamond (TR8)', () => {
    expect(isImportantTierChange('silver', 'gold')).toBe(true);
    expect(isImportantTierChange('diamond', 'bronze')).toBe(true);
    expect(isImportantTierChange('bronze', 'silver')).toBe(false);
    expect(isImportantTierChange('gold', 'gold')).toBe(false);
  });
});

describe('effectiveLevel (TR3, MG6)', () => {
  it('takes the grant when its tier is live and above the earned tier', () => {
    expect(effectiveLevel(silver, 'gold', levels)).toEqual({ level: gold, source: 'granted' });
    expect(effectiveLevel(null, 'silver', levels)).toEqual({ level: silver, source: 'granted' });
  });

  it('keeps the earned level otherwise (edge case 4)', () => {
    expect(effectiveLevel(gold, 'silver', levels)).toEqual({ level: gold, source: 'earned' });
    expect(effectiveLevel(gold, 'gold', levels)).toEqual({ level: gold, source: 'earned' });
    expect(effectiveLevel(silver, null, levels)).toEqual({ level: silver, source: 'earned' });
    expect(effectiveLevel(null, null, levels)).toEqual({ level: null, source: null });
  });

  it('ignores a grant whose tier has no live level', () => {
    expect(effectiveLevel(silver, 'diamond', [silver, gold])).toEqual({
      level: silver,
      source: 'earned',
    });
  });
});

describe('the levels rules', () => {
  it('needs thresholds rising with the tier', () => {
    expect(tierThresholdsRise(levels)).toBe(true);
    expect(tierThresholdsRise([...levels].reverse())).toBe(true);
    expect(tierThresholdsRise([])).toBe(true);
    expect(tierThresholdsRise([silver, { ...gold, monthlyThresholdUsdUnits: 300 * USD }])).toBe(
      false,
    );
  });

  it("names the next lower live tier's list as parent, else wholesale", () => {
    const lists = [
      { tier: 'silver' as const, priceListId: 'silver-list' },
      { tier: 'gold' as const, priceListId: 'gold-list' },
    ];
    expect(expectedParentListId('silver', lists, 'wholesale')).toBe('wholesale');
    expect(expectedParentListId('gold', lists, 'wholesale')).toBe('silver-list');
    expect(expectedParentListId('diamond', lists, 'wholesale')).toBe('gold-list');
    expect(expectedParentListId('gold', [], 'wholesale')).toBe('wholesale');
  });

  it('takes whole dollars and a list, or null to archive', () => {
    const list = '01a15a8c-b312-75f3-92d2-65b29d838051';
    const parse = (body: object) => tierLevelInputSchema.safeParse(body).success;
    expect(parse({ level: { monthlyThresholdUsdUnits: 300 * USD, priceListId: list } })).toBe(true);
    expect(parse({ level: null })).toBe(true);
    expect(parse({ level: { monthlyThresholdUsdUnits: 300.5 * USD, priceListId: list } })).toBe(
      false,
    );
    expect(parse({ level: { monthlyThresholdUsdUnits: 0, priceListId: list } })).toBe(false);
  });
});

describe('tier settings (TS1, TS2)', () => {
  it('accepts the seeded defaults, which rise with the tier', () => {
    for (const settings of Object.values(TIER_SETTINGS_DEFAULTS)) {
      expect(tierSettingsInputSchema.safeParse(settings).success).toBe(true);
    }
    expect(TIER_SETTINGS_DEFAULTS.diamond.directContact).toBe(true);
    expect(TIER_THRESHOLD_DEFAULTS.gold).toBe(1_000 * USD);
  });

  it('refuses a per-deposit limit above the daily one, checks above the day, quantities over 100', () => {
    const base = TIER_SETTINGS_DEFAULTS.gold;
    const parse = (change: object) =>
      tierSettingsInputSchema.safeParse({ ...base, ...change }).success;
    expect(parse({ perDepositUsdUnits: base.dailyDepositUsdUnits + USD })).toBe(false);
    expect(parse({ playerChecksPerHour: 900 })).toBe(false);
    expect(parse({ bulkLinesMax: 101 })).toBe(false);
    expect(parse({ orderUnitsMax: 0 })).toBe(false);
    expect(parse({ supportReplyMinutes: 10 })).toBe(false);
    expect(parse({ supportReplyMinutes: null })).toBe(true);
    expect(parse({ perDepositUsdUnits: 1_000_001 })).toBe(false);
  });
});

describe('the threshold preview (AD3)', () => {
  it('gives the highest tier reached by the larger month', () => {
    const thresholds = { silver: 300 * USD, gold: 1_000 * USD, diamond: null };
    expect(earnedTierFor(thresholds, 0, 0)).toBe('bronze');
    expect(earnedTierFor(thresholds, 300 * USD, 0)).toBe('silver');
    expect(earnedTierFor(thresholds, 0, 5_000 * USD)).toBe('gold');
    expect(earnedTierFor({}, 5_000 * USD, 0)).toBe('bronze');
  });

  it('refuses thresholds that do not rise', () => {
    expect(
      tierPreviewInputSchema.safeParse({ silver: 300 * USD, gold: 800 * USD, diamond: null })
        .success,
    ).toBe(true);
    expect(
      tierPreviewInputSchema.safeParse({ silver: 900 * USD, gold: 800 * USD, diamond: null })
        .success,
    ).toBe(false);
  });
});

describe('grants (MG1)', () => {
  it('takes a level tier, a day and a reason of 5–500 characters', () => {
    const parse = (body: object) => tierGrantInputSchema.safeParse(body).success;
    expect(parse({ tier: 'gold', endsOn: '2026-11-15', reason: 'شريك جديد' })).toBe(true);
    expect(parse({ tier: 'bronze', endsOn: '2026-11-15', reason: 'شريك جديد' })).toBe(false);
    expect(parse({ tier: 'gold', endsOn: '2026-11-15', reason: 'قصير' })).toBe(false);
    expect(parse({ tier: 'gold', endsOn: '15/11/2026', reason: 'شريك جديد' })).toBe(false);
  });

  it("describes the profile's tier", () => {
    expect(
      adminMerchantTierSchema.safeParse({
        tier: 'gold',
        earnedTier: 'silver',
        source: 'granted',
        since: null,
        openGrant: null,
        grants: [],
      }).success,
    ).toBe(true);
  });
});

describe('tierProgress (PG1)', () => {
  it('measures this month against the next live tier above the effective one', () => {
    expect(tierProgress(levels, 720 * USD, 'silver')).toEqual({
      next: { tier: 'gold', thresholdUsdUnits: 1_000 * USD, missingUsdUnits: 280 * USD },
      reachedPermille: 720,
      keep: null,
    });
    expect(tierProgress(levels, -5 * USD, 'bronze')).toMatchObject({
      next: { tier: 'silver', missingUsdUnits: 300 * USD },
      reachedPermille: 0,
    });
    expect(tierProgress(levels, 2_000 * USD, 'silver').next).toMatchObject({ missingUsdUnits: 0 });
    expect(tierProgress(levels, 2_000 * USD, 'silver').reachedPermille).toBe(1_000);
  });

  it('at the top tells what keeps it next month', () => {
    expect(tierProgress(levels, 1_200 * USD, 'diamond')).toEqual({
      next: null,
      reachedPermille: 400,
      keep: { thresholdUsdUnits: 3_000 * USD, missingUsdUnits: 1_800 * USD },
    });
    expect(tierProgress(levels, 4_000 * USD, 'diamond').keep?.missingUsdUnits).toBe(0);
  });

  it('has nothing to show without levels', () => {
    expect(tierProgress([], 10 * USD, 'bronze')).toEqual({
      next: null,
      reachedPermille: 0,
      keep: null,
    });
  });
});

describe('tierKeptUntil (TR7, PG7)', () => {
  it('holds to the end of next month when this month reached the threshold', () => {
    expect(tierKeptUntil(levels, 1_000 * USD, 'gold', '2026-10')).toBe('2026-11-30');
    expect(tierKeptUntil(levels, 300 * USD, 'silver', '2026-12')).toBe('2027-01-31');
  });

  it('holds to the end of this month when only the previous month did', () => {
    expect(tierKeptUntil(levels, 10 * USD, 'gold', '2028-02')).toBe('2028-02-29');
  });

  it('has no date for Bronze or a tier without a level', () => {
    expect(tierKeptUntil(levels, 0, 'bronze', '2026-10')).toBeNull();
    expect(tierKeptUntil([silver], 0, 'gold', '2026-10')).toBeNull();
  });
});

describe('tierForecast (PG4)', () => {
  it('waits for the 5th and a positive month', () => {
    expect(tierForecast(500 * USD, 4, 30, 1_000 * USD)).toBeNull();
    expect(tierForecast(0, 10, 30, 1_000 * USD)).toBeNull();
  });

  it('names the day the next threshold falls within the month', () => {
    // $400 in 10 days: $40 a day reaches $1,000 on day 25.
    expect(tierForecast(400 * USD, 10, 30, 1_000 * USD)).toEqual({ kind: 'reach', day: 25 });
    // Rounded up: $300 in 10 days reaches $1,000 on day 33.3 → beyond a 31-day month.
    expect(tierForecast(300 * USD, 10, 31, 1_000 * USD)).toEqual({
      kind: 'total',
      projectedUsdUnits: 930 * USD,
    });
  });

  it('floors the projection to whole cents', () => {
    expect(tierForecast(10_000_001, 7, 30, null)).toEqual({
      kind: 'total',
      projectedUsdUnits: 42_850_000,
    });
  });

  it('projects the month without a next threshold or when it is reached', () => {
    expect(tierForecast(700 * USD, 7, 30, null)).toEqual({
      kind: 'total',
      projectedUsdUnits: 3_000 * USD,
    });
    expect(tierForecast(1_200 * USD, 12, 30, 1_000 * USD)).toEqual({
      kind: 'total',
      projectedUsdUnits: 3_000 * USD,
    });
  });
});

describe('tierReminder (PG3)', () => {
  it('reminds to keep a tier the previous month carried', () => {
    expect(tierReminder(levels, 1_100 * USD, 400 * USD, 'gold')).toEqual({
      kind: 'keep',
      tier: 'gold',
      missingUsdUnits: 600 * USD,
    });
    expect(tierReminder(levels, 1_100 * USD, -20 * USD, 'gold')).toMatchObject({
      missingUsdUnits: 1_000 * USD,
    });
  });

  it('reminds to reach the next tier within 30% of its threshold', () => {
    expect(tierReminder(levels, 0, 700 * USD, 'silver')).toEqual({
      kind: 'reach',
      tier: 'gold',
      missingUsdUnits: 300 * USD,
    });
    expect(tierReminder(levels, 0, 699 * USD, 'silver')).toBeNull();
  });

  it('stays silent at the top and for a merchant far from Silver (edge cases 11, 12)', () => {
    expect(tierReminder(levels, 3_500 * USD, 3_100 * USD, 'diamond')).toBeNull();
    expect(tierReminder(levels, 0, 0, 'bronze')).toBeNull();
    expect(tierReminder(levels, 0, 1_000 * USD, 'silver')).toBeNull();
    expect(tierReminder([], 0, 0, 'bronze')).toBeNull();
  });
});

describe('the welcome line (RC1)', () => {
  it('takes 2–60 characters after trimming', () => {
    expect(welcomeTextSchema.parse('  أهلاً بكم في متجرنا  ')).toBe('أهلاً بكم في متجرنا');
    expect(welcomeTextSchema.safeParse('أ').success).toBe(false);
    expect(welcomeTextSchema.safeParse('x'.repeat(61)).success).toBe(false);
  });

  it('refuses control characters, links and long digit runs', () => {
    for (const text of [
      'مرحبا',
      'زورونا‏هنا',
      'https://example.test',
      'www.shop.test',
      'تابعونا shop.com',
      'راسلونا t.me/shop',
      'اتصل 0991234567',
      'اتصل ٠٩٩١٢٣٤٥٦٧',
      'اتصل 099 123 45 67',
      // Bypasses the reviewer found: any top-level domain, spaced dots, any separator, any script.
      'زورونا scam.shop',
      'pay . ru',
      'تابعونا t . me / shop',
      'x.pro',
      'telegram @shop_sy',
      'اتصل 0933/123/456',
      'اتصل (0933)123456',
      'اتصل 0933_123_456',
      'اتصل 0933،123،456',
      'اتصل ０９３３１２３４５６',
      'اتصل ০৯৩৩১২৩৪৫৬',
    ]) {
      expect(welcomeTextSchema.safeParse(text).success, text).toBe(false);
    }
    for (const text of ['خصم 10% على 500 UC', 'أهلاً بكم. نخدمكم يومياً', 'شحن 24 ساعة']) {
      expect(welcomeTextSchema.safeParse(text).success, text).toBe(true);
    }
  });
});
