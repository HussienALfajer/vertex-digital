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
  tierGrantInputSchema,
  tierLevelInputSchema,
  tierOf,
  tierPreviewInputSchema,
  tierRank,
  tierSettingsInputSchema,
  tierThresholdsRise,
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
