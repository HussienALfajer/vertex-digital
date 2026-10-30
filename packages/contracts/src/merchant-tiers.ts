import { z } from 'zod';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  floorToWholeCents,
  isWholeCents,
  USD_CENT,
} from './money.js';
import {
  LEVEL_TIERS,
  type LevelTier,
  levelTierSchema,
  MERCHANT_TIERS,
  type MerchantTier,
  merchantTierSchema,
} from './price-kinds.js';

/*
 * Merchant tiers (S23 F43, ADR 0038), owned by the api `merchants` module: four fixed tiers on top
 * of S21's volume levels, the effective tier (the higher of earned and granted), the per-tier
 * settings (privileges), the admin's manual grants and the threshold preview. Imports only
 * `money` and `price-kinds`, so `merchants.ts` and the store's pages may read it.
 */

export {
  LEVEL_TIERS,
  type LevelTier,
  levelTierSchema,
  MERCHANT_TIERS,
  type MerchantTier,
  merchantTierSchema,
};

/** Decision 1: the tiers' Arabic names. */
export const TIER_NAMES_AR = {
  bronze: 'برونزي',
  silver: 'فضي',
  gold: 'ذهبي',
  diamond: 'ماسي',
} as const satisfies Record<MerchantTier, string>;

/** TR1: a tier's place, Bronze 0 to Diamond 3. */
export function tierRank(tier: MerchantTier): number {
  return MERCHANT_TIERS.indexOf(tier);
}

/** TR1: the higher of two tiers. */
export function higherTier(a: MerchantTier, b: MerchantTier): MerchantTier {
  return tierRank(b) > tierRank(a) ? b : a;
}

/** A live level as the tier rules read it. */
export interface TierLevel {
  id: string;
  tier: LevelTier;
  monthlyThresholdUsdUnits: number;
}

/** TR1: a level's tier, Bronze without one. */
export function tierOf(level: Pick<TierLevel, 'tier'> | null | undefined): MerchantTier {
  return level?.tier ?? 'bronze';
}

/** Where the effective level comes from (TR3); null with no level. */
export const LEVEL_SOURCES = ['earned', 'granted'] as const;

export const levelSourceSchema = z.enum(LEVEL_SOURCES).meta({ id: 'MerchantLevelSource' });

export type LevelSource = z.infer<typeof levelSourceSchema>;

/**
 * TR3, MG6: the higher of the earned level and the live level of the open grant's tier; a grant
 * whose tier has no live level, or is not above the earned tier, has no effect (`earned`).
 */
export function effectiveLevel<Level extends TierLevel>(
  earned: Level | null,
  grantTier: LevelTier | null,
  levels: readonly Level[],
): { level: Level | null; source: LevelSource | null } {
  const granted = grantTier === null ? undefined : levels.find((level) => level.tier === grantTier);
  if (granted && tierRank(granted.tier) > tierRank(tierOf(earned))) {
    return { level: granted, source: 'granted' };
  }
  return { level: earned, source: earned === null ? null : 'earned' };
}

/** What caused a change of effective tier (`merchant_tier_changes.source`). */
export const TIER_CHANGE_SOURCES = [
  'earned',
  'granted',
  'grant_ended',
  'revoked',
  'tiers_changed',
] as const;

export const tierChangeSourceSchema = z
  .enum(TIER_CHANGE_SOURCES)
  .meta({ id: 'MerchantTierChangeSource' });

export type TierChangeSource = z.infer<typeof tierChangeSourceSchema>;

/** TR8: a change into or out of Gold or Diamond is an important change for Telegram. */
export function isImportantTierChange(from: MerchantTier, to: MerchantTier): boolean {
  const important = (tier: MerchantTier) => tier === 'gold' || tier === 'diamond';
  return from !== to && (important(from) || important(to));
}

/* Levels per tier (S21 levels, amended) ------------------------------------------------------ */

/** TR1: a tier's level, whole dollars of net purchases a month, on a custom list. */
export const tierLevelValuesSchema = z.object({
  monthlyThresholdUsdUnits: z
    .int()
    .min(CURRENCY_SCALE.USD)
    .max(Number.MAX_SAFE_INTEGER)
    .refine((units) => units % CURRENCY_SCALE.USD === 0, 'Expected whole dollars'),
  priceListId: z.uuid(),
});

export type TierLevelValues = z.infer<typeof tierLevelValuesSchema>;

/**
 * `PUT /api/admin/merchant-tiers/:tier/level`: the tier's level, created or updated; null archives
 * the live level.
 */
export const tierLevelInputSchema = z
  .object({ level: tierLevelValuesSchema.nullable() })
  .meta({ id: 'MerchantTierLevelInput' });

export type TierLevelInput = z.infer<typeof tierLevelInputSchema>;

/**
 * `merchant_levels` rules: thresholds rise with the tier among the live levels. `levels` are the
 * live levels after the change.
 */
export function tierThresholdsRise(
  levels: readonly Pick<TierLevel, 'tier' | 'monthlyThresholdUsdUnits'>[],
): boolean {
  const ordered = [...levels].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  return ordered.every(
    (level, index) =>
      index === 0 ||
      level.monthlyThresholdUsdUnits >
        (ordered[index - 1] as (typeof ordered)[number]).monthlyThresholdUsdUnits,
  );
}

/**
 * `merchant_levels` rules: the parent a tier's list must have, the list of the next lower live
 * tier, else the wholesale root (a Gold level without Silver inherits from wholesale).
 */
export function expectedParentListId(
  tier: LevelTier,
  levels: readonly { tier: LevelTier; priceListId: string }[],
  wholesaleListId: string,
): string {
  const lower = levels
    .filter((level) => tierRank(level.tier) < tierRank(tier))
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
  return lower?.priceListId ?? wholesaleListId;
}

/* Tier settings (TS1–TS5) -------------------------------------------------------------------- */

/** TS5: the most bulk lines and code units per order any tier may allow. */
export const TIER_QUANTITY_CEILING = 100;

const depositLimit = z
  .int()
  .min(USD_CENT)
  .max(100_000 * CURRENCY_SCALE.USD)
  .refine(isWholeCents, 'Expected whole cents');

/** `PUT /api/admin/merchant-tiers/:tier/settings` (TS1, TS2): a tier's privileges. */
export const tierSettingsInputSchema = z
  .object({
    perDepositUsdUnits: depositLimit,
    dailyDepositUsdUnits: depositLimit,
    playerChecksPerHour: z.int().min(10).max(1_000),
    playerChecksPerDay: z.int().min(30).max(5_000),
    bulkLinesMax: z.int().min(10).max(TIER_QUANTITY_CEILING),
    orderUnitsMax: z.int().min(1).max(TIER_QUANTITY_CEILING),
    depositPriority: z.boolean(),
    supportPriority: z.boolean(),
    /** Minutes; null promises no reply time. */
    supportReplyMinutes: z.int().min(15).max(1_440).nullable(),
    directContact: z.boolean(),
    earlyAccess: z.boolean(),
    fastAlerts: z.boolean(),
    receiptWelcome: z.boolean(),
    receiptLargeLogo: z.boolean(),
  })
  .refine((value) => value.perDepositUsdUnits <= value.dailyDepositUsdUnits, {
    path: ['perDepositUsdUnits'],
    message: 'Above the daily limit',
  })
  .refine((value) => value.playerChecksPerHour <= value.playerChecksPerDay, {
    path: ['playerChecksPerHour'],
    message: 'Above the daily checks',
  })
  .meta({ id: 'MerchantTierSettingsInput' });

export type TierSettingsInput = z.infer<typeof tierSettingsInputSchema>;

const usd = (dollars: number) => dollars * CURRENCY_SCALE.USD;

const NO_PRIVILEGES = {
  depositPriority: false,
  supportPriority: false,
  supportReplyMinutes: null,
  directContact: false,
  earlyAccess: false,
  fastAlerts: false,
  receiptWelcome: false,
  receiptLargeLogo: false,
} as const;

/**
 * TS2: the seeded values. Bronze's deposit and check values are the merchant settings' (the
 * migration copies the newest row, so nothing changes for today's merchants).
 */
export const TIER_SETTINGS_DEFAULTS = {
  bronze: {
    perDepositUsdUnits: usd(2_000),
    dailyDepositUsdUnits: usd(5_000),
    playerChecksPerHour: 100,
    playerChecksPerDay: 300,
    bulkLinesMax: 50,
    orderUnitsMax: 50,
    ...NO_PRIVILEGES,
  },
  silver: {
    perDepositUsdUnits: usd(3_000),
    dailyDepositUsdUnits: usd(8_000),
    playerChecksPerHour: 150,
    playerChecksPerDay: 500,
    bulkLinesMax: 50,
    orderUnitsMax: 50,
    ...NO_PRIVILEGES,
    receiptWelcome: true,
  },
  gold: {
    perDepositUsdUnits: usd(5_000),
    dailyDepositUsdUnits: usd(15_000),
    playerChecksPerHour: 250,
    playerChecksPerDay: 800,
    bulkLinesMax: 100,
    orderUnitsMax: 100,
    depositPriority: true,
    supportPriority: true,
    supportReplyMinutes: 180,
    directContact: false,
    earlyAccess: true,
    fastAlerts: true,
    receiptWelcome: true,
    receiptLargeLogo: true,
  },
  diamond: {
    perDepositUsdUnits: usd(10_000),
    dailyDepositUsdUnits: usd(30_000),
    playerChecksPerHour: 400,
    playerChecksPerDay: 1_500,
    bulkLinesMax: 100,
    orderUnitsMax: 100,
    depositPriority: true,
    supportPriority: true,
    supportReplyMinutes: 60,
    directContact: true,
    earlyAccess: true,
    fastAlerts: true,
    receiptWelcome: true,
    receiptLargeLogo: true,
  },
} as const satisfies Record<MerchantTier, TierSettingsInput>;

/** PX1: the starter thresholds the setup command writes. */
export const TIER_THRESHOLD_DEFAULTS = {
  silver: usd(300),
  gold: usd(1_000),
  diamond: usd(3_000),
} as const satisfies Record<LevelTier, number>;

/** PX1: the names the setup command gives the wholesale list and the tier lists. */
export const TIER_LIST_NAMES = {
  bronze: 'البرونزية',
  silver: 'الفضية',
  gold: 'الذهبية',
  diamond: 'الماسية',
} as const satisfies Record<MerchantTier, string>;

/** A tier list's margin (percent in basis points, the minimum margin in USD units; fixed $0). */
export interface TierRuleValues {
  percentBp: number;
  minMarginUsdUnits: number;
}

/**
 * PX3 (decisions 3, 4): the rules the setup command writes on each tier list: the global rule
 * (game top-ups and game cards take the full step), half the step for chat and streaming apps and
 * subscriptions, none (Bronze's 5% and $0.05) for store, platform and shopping cards.
 */
export const TIER_RULE_DEFAULTS = {
  global: {
    silver: { percentBp: 400, minMarginUsdUnits: 40_000 },
    gold: { percentBp: 300, minMarginUsdUnits: 30_000 },
    diamond: { percentBp: 200, minMarginUsdUnits: 20_000 },
  },
  // A minimum margin is whole cents (S07): $0.045 and $0.035 rounded up (owner, 2026-10-29).
  half: {
    silver: { percentBp: 450, minMarginUsdUnits: 50_000 },
    gold: { percentBp: 400, minMarginUsdUnits: 40_000 },
    diamond: { percentBp: 350, minMarginUsdUnits: 40_000 },
  },
  none: {
    silver: { percentBp: 500, minMarginUsdUnits: 50_000 },
    gold: { percentBp: 500, minMarginUsdUnits: 50_000 },
    diamond: { percentBp: 500, minMarginUsdUnits: 50_000 },
  },
} as const satisfies Record<'global' | 'half' | 'none', Record<LevelTier, TierRuleValues>>;

/**
 * PX3: the production categories that take a category rule, by slug (read from the production
 * store on 2026-10-29: `games` and `game-cards` take the global rule). A missing slug is skipped.
 */
export const TIER_CATEGORY_STEPS = {
  half: ['apps', 'subscriptions'],
  none: ['gift-cards', 'shopping'],
} as const;

/** A tier's settings in force (TS1). */
export const tierSettingsSchema = z
  .object({
    ...tierSettingsInputSchema.shape,
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MerchantTierSettings' });

export type TierSettings = z.infer<typeof tierSettingsSchema>;

/* The tiers page (AD2) ----------------------------------------------------------------------- */

export const merchantTierListRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  parentListId: z.uuid().nullable(),
  archived: z.boolean(),
});

export const merchantTierViewSchema = z
  .object({
    tier: merchantTierSchema,
    /** The live level; null for Bronze and for a tier without one. */
    level: z
      .object({
        id: z.uuid(),
        monthlyThresholdUsdUnits: amountUnitsSchema,
        priceList: merchantTierListRefSchema,
        /** The list's parent should be this list (`merchant_levels` rules): a gap shows it. */
        expectedParentListId: z.uuid(),
      })
      .nullable(),
    /** Bronze's list (wholesale) and each level's list. */
    priceList: merchantTierListRefSchema.nullable(),
    settings: tierSettingsSchema,
    /** Merchants holding the tier now, by source (Bronze: every merchant without a level). */
    merchants: z.object({
      earned: z.int().nonnegative(),
      granted: z.int().nonnegative(),
    }),
  })
  .meta({ id: 'MerchantTierView' });

export type MerchantTierView = z.infer<typeof merchantTierViewSchema>;

/** `GET /api/admin/merchant-tiers`: the four tiers, Bronze first. */
export const merchantTierListSchema = z
  .object({
    items: z.array(merchantTierViewSchema),
    /** The highest deposit minimum (Sham Cash, USDT): both deposit limits must reach it. */
    minDepositUsdUnits: amountUnitsSchema,
  })
  .meta({ id: 'MerchantTierList' });

export type MerchantTierList = z.infer<typeof merchantTierListSchema>;

/* The threshold preview (AD3) ---------------------------------------------------------------- */

/** AD3: at most 50 trade names per list of movers. */
export const TIER_PREVIEW_MOVERS_MAX = 50;

/** `POST /api/admin/merchant-tiers/preview`: proposed thresholds; null is no level. */
export const tierPreviewInputSchema = z
  .object({
    silver: tierLevelValuesSchema.shape.monthlyThresholdUsdUnits.nullable(),
    gold: tierLevelValuesSchema.shape.monthlyThresholdUsdUnits.nullable(),
    diamond: tierLevelValuesSchema.shape.monthlyThresholdUsdUnits.nullable(),
  })
  .refine(
    (value) =>
      tierThresholdsRise(
        LEVEL_TIERS.flatMap((tier) => {
          const units = value[tier];
          return units === null ? [] : [{ tier, monthlyThresholdUsdUnits: units }];
        }),
      ),
    { message: 'Thresholds must rise with the tier' },
  )
  .meta({ id: 'MerchantTierPreviewInput' });

export type TierPreviewInput = z.infer<typeof tierPreviewInputSchema>;

const tierMoverSchema = z.object({
  customerId: z.uuid(),
  tradeName: z.string(),
  from: merchantTierSchema,
  to: merchantTierSchema,
});

export const tierPreviewSchema = z
  .object({
    /** Per tier, the merchants who would earn it (LV3 on the previous and this month). */
    tiers: z.array(
      z.object({
        tier: merchantTierSchema,
        now: z.int().nonnegative(),
        proposed: z.int().nonnegative(),
      }),
    ),
    rising: z.array(tierMoverSchema).max(TIER_PREVIEW_MOVERS_MAX),
    risingTotal: z.int().nonnegative(),
    falling: z.array(tierMoverSchema).max(TIER_PREVIEW_MOVERS_MAX),
    fallingTotal: z.int().nonnegative(),
  })
  .meta({ id: 'MerchantTierPreview' });

export type TierPreview = z.infer<typeof tierPreviewSchema>;

/**
 * AD3: the earned tier each threshold set gives (LV3: the larger of the previous and this month);
 * `thresholds` are the tiers with a level.
 */
export function earnedTierFor(
  thresholds: Partial<Record<LevelTier, number | null>>,
  previousMonthUsdUnits: number,
  thisMonthUsdUnits: number,
): MerchantTier {
  const reached = Math.max(previousMonthUsdUnits, thisMonthUsdUnits);
  let best: MerchantTier = 'bronze';
  for (const tier of LEVEL_TIERS) {
    const threshold = thresholds[tier];
    if (threshold !== null && threshold !== undefined && threshold <= reached) {
      best = higherTier(best, tier);
    }
  }
  return best;
}

/* Manual grants (MG1–MG7) -------------------------------------------------------------------- */

/** MG1: a grant runs 1 to 90 days. */
export const TIER_GRANT_MAX_DAYS = 90;

export const TIER_GRANT_END_REASONS = [
  'expired',
  'ended_by_admin',
  'merchant_revoked',
  'tier_archived',
] as const;

export const tierGrantEndReasonSchema = z
  .enum(TIER_GRANT_END_REASONS)
  .meta({ id: 'MerchantTierGrantEndReason' });

export type TierGrantEndReason = z.infer<typeof tierGrantEndReasonSchema>;

const grantReason = z.string().trim().min(5).max(500);

/**
 * `POST /api/admin/customers/:id/merchant/tier-grant` (MG1): the tier and the Damascus day it ends
 * on (1–90 days from today; it ends at that day's end).
 */
export const tierGrantInputSchema = z
  .object({ tier: levelTierSchema, endsOn: z.iso.date(), reason: grantReason })
  .meta({ id: 'MerchantTierGrantInput' });

export type TierGrantInput = z.infer<typeof tierGrantInputSchema>;

/** `POST …/tier-grant/end` (MG3). */
export const tierGrantEndInputSchema = z
  .object({ reason: grantReason })
  .meta({ id: 'MerchantTierGrantEndInput' });

export type TierGrantEndInput = z.infer<typeof tierGrantEndInputSchema>;

export const tierGrantSchema = z
  .object({
    id: z.uuid(),
    tier: levelTierSchema,
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    reason: z.string(),
    endedAt: z.iso.datetime().nullable(),
    endReason: tierGrantEndReasonSchema.nullable(),
  })
  .meta({ id: 'MerchantTierGrant' });

export type TierGrant = z.infer<typeof tierGrantSchema>;

/** The merchant's tier as the admin's profile shows it (AD5). */
export const adminMerchantTierSchema = z
  .object({
    tier: merchantTierSchema,
    earnedTier: merchantTierSchema,
    source: levelSourceSchema.nullable(),
    since: z.iso.datetime().nullable(),
    openGrant: tierGrantSchema.nullable(),
    /** The newest grants first, the open one included. */
    grants: z.array(tierGrantSchema),
  })
  .meta({ id: 'AdminMerchantTier' });

export type AdminMerchantTier = z.infer<typeof adminMerchantTierSchema>;

/* Progress (PG1, PG3, PG4, PG7, TR7) --------------------------------------------------------- */

/**
 * PG1: the next live tier above the effective tier, its threshold, the amount this month misses
 * and the share reached (per mille); at the highest live tier, the amount this month still needs
 * to keep it next month (`keep`). Negative months (refunds) count as zero.
 */
export function tierProgress(
  levels: readonly TierLevel[],
  thisMonthUsdUnits: number,
  effectiveTier: MerchantTier,
): {
  next: { tier: LevelTier; thresholdUsdUnits: number; missingUsdUnits: number } | null;
  reachedPermille: number;
  keep: { thresholdUsdUnits: number; missingUsdUnits: number } | null;
} {
  const reached = Math.max(thisMonthUsdUnits, 0);
  const permille = (threshold: number) =>
    Math.min(1_000, Math.floor(Number((BigInt(reached) * 1_000n) / BigInt(threshold))));
  const next = [...levels]
    .filter((level) => tierRank(level.tier) > tierRank(effectiveTier))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))[0];
  if (next) {
    const threshold = next.monthlyThresholdUsdUnits;
    return {
      next: {
        tier: next.tier,
        thresholdUsdUnits: threshold,
        missingUsdUnits: Math.max(threshold - reached, 0),
      },
      reachedPermille: permille(threshold),
      keep: null,
    };
  }
  const own = levels.find((level) => level.tier === effectiveTier);
  if (!own) return { next: null, reachedPermille: 0, keep: null };
  const threshold = own.monthlyThresholdUsdUnits;
  return {
    next: null,
    reachedPermille: permille(threshold),
    keep: { thresholdUsdUnits: threshold, missingUsdUnits: Math.max(threshold - reached, 0) },
  };
}

/** The last day of a `YYYY-MM` month, `YYYY-MM-DD`. */
function lastDayOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** The month after a `YYYY-MM` month. */
function nextMonthOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}

/**
 * TR7, PG7: the last Damascus day the earned tier is held (`YYYY-MM-DD`): the end of next month
 * when this month has reached its threshold, else the end of this month (the previous month
 * carried it). Null for Bronze, or for a tier whose level is gone.
 */
export function tierKeptUntil(
  levels: readonly TierLevel[],
  thisMonthUsdUnits: number,
  earnedTier: MerchantTier,
  month: string,
): string | null {
  const own = levels.find((level) => level.tier === earnedTier);
  if (!own) return null;
  return lastDayOf(thisMonthUsdUnits >= own.monthlyThresholdUsdUnits ? nextMonthOf(month) : month);
}

/** PG4: no forecast before the 5th of the month. */
export const TIER_FORECAST_FROM_DAY = 5;

export type TierForecast =
  | { kind: 'reach'; day: number }
  | { kind: 'total'; projectedUsdUnits: number };

/**
 * PG4: this month at its daily pace so far. `reach` with the day of the month the next threshold
 * is reached when that falls within the month; else `total` with the projected month. Null before
 * the 5th or with nothing bought. The projection is floored to whole cents, as it is shown.
 */
export function tierForecast(
  thisMonthUsdUnits: number,
  dayOfMonth: number,
  daysInMonth: number,
  nextThresholdUsdUnits: number | null,
): TierForecast | null {
  if (dayOfMonth < TIER_FORECAST_FROM_DAY || thisMonthUsdUnits <= 0) return null;
  const total = BigInt(thisMonthUsdUnits);
  if (nextThresholdUsdUnits !== null && nextThresholdUsdUnits > thisMonthUsdUnits) {
    const scaled = BigInt(nextThresholdUsdUnits) * BigInt(dayOfMonth);
    const day = Number((scaled + total - 1n) / total);
    if (day <= daysInMonth) return { kind: 'reach', day };
  }
  return {
    kind: 'total',
    projectedUsdUnits: floorToWholeCents(
      Number((total * BigInt(daysInMonth)) / BigInt(dayOfMonth)),
    ),
  };
}

/** PG3: a reminder goes to a merchant within 30% of the next tier's threshold. */
export const TIER_REMINDER_REACH_PERCENT = 30;

export type TierReminder =
  | { kind: 'keep'; tier: LevelTier; missingUsdUnits: number }
  | { kind: 'reach'; tier: LevelTier; missingUsdUnits: number };

/**
 * PG3: `keep` when the earned tier came from the previous month only (this month below its
 * threshold); else `reach` when this month misses the next tier above the earned one by at most
 * 30% of its threshold; else null (edge cases 11, 12).
 */
export function tierReminder(
  levels: readonly TierLevel[],
  previousMonthUsdUnits: number,
  thisMonthUsdUnits: number,
  earnedTier: MerchantTier,
): TierReminder | null {
  const reached = Math.max(thisMonthUsdUnits, 0);
  const own = levels.find((level) => level.tier === earnedTier);
  if (
    own &&
    reached < own.monthlyThresholdUsdUnits &&
    previousMonthUsdUnits >= own.monthlyThresholdUsdUnits
  ) {
    return {
      kind: 'keep',
      tier: own.tier,
      missingUsdUnits: own.monthlyThresholdUsdUnits - reached,
    };
  }
  const next = [...levels]
    .filter((level) => tierRank(level.tier) > tierRank(earnedTier))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))[0];
  if (!next) return null;
  const missing = next.monthlyThresholdUsdUnits - reached;
  if (missing <= 0) return null;
  if (missing * 100 > next.monthlyThresholdUsdUnits * TIER_REMINDER_REACH_PERCENT) return null;
  return { kind: 'reach', tier: next.tier, missingUsdUnits: missing };
}

/* The merchant's tier (ID3, PG1–PG6) --------------------------------------------------------- */

/** TS2: a tier's privileges as the merchant reads them (ID3, PG2). */
export const tierPrivilegesSchema = z
  .object(tierSettingsInputSchema.shape)
  .meta({ id: 'MerchantTierPrivileges' });

export type TierPrivileges = z.infer<typeof tierPrivilegesSchema>;

const progressSchema = z.object({
  /** The next live tier; null at the highest live tier. */
  next: z
    .object({
      tier: levelTierSchema,
      thresholdUsdUnits: amountUnitsSchema,
      missingUsdUnits: amountUnitsSchema,
    })
    .nullable(),
  /** This month against the next threshold (or the own one at the top), 0–1000. */
  reachedPermille: z.int().min(0).max(1_000),
  /** At the highest live tier: what this month still needs to keep it next month. */
  keep: z
    .object({ thresholdUsdUnits: amountUnitsSchema, missingUsdUnits: amountUnitsSchema })
    .nullable(),
});

const forecastSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reach'), day: z.int().min(1).max(31) }),
  z.object({ kind: z.literal('total'), projectedUsdUnits: amountUnitsSchema }),
]);

/**
 * `GET /api/merchant/tier` (ID3, PG1, PG4, PG6, TR7): the effective tier, never where it comes
 * from (decision 13). `keptUntil` is null for Bronze and while a grant sets the tier above the
 * earned one; `savingsUsdUnits` is null unless the account is priced by a tier's list.
 */
export const merchantTierSummarySchema = z
  .object({
    tier: merchantTierSchema,
    since: z.iso.datetime(),
    keptUntil: z.iso.date().nullable(),
    month: z.string(),
    thisMonthUsdUnits: z.int(),
    progress: progressSchema,
    forecast: forecastSchema.nullable(),
    savingsUsdUnits: amountUnitsSchema.nullable(),
    privileges: tierPrivilegesSchema,
    /** ID4: the celebration sheet is due. */
    celebrate: z.boolean(),
    /**
     * OP4: the Diamond contact links, only for a tier with `directContact` and only those the
     * merchant settings name; null otherwise.
     */
    contact: z
      .object({ whatsappUrl: z.url().nullable(), telegramUrl: z.url().nullable() })
      .nullable(),
  })
  .meta({ id: 'MerchantTierSummary' });

export type MerchantTierSummary = z.infer<typeof merchantTierSummarySchema>;

/* The Diamond contact (OP4, decision 12) ---------------------------------------------------- */

/** OP4: a Telegram username as `t.me` takes it. */
export const telegramUsernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{5,32}$/);

/**
 * OP4: the contact buttons' links from the merchant settings (an E.164 number, a username); null
 * when neither is set.
 */
export function directContactLinks(
  whatsapp: string | null,
  telegram: string | null,
): { whatsappUrl: string | null; telegramUrl: string | null } | null {
  if (whatsapp === null && telegram === null) return null;
  return {
    whatsappUrl: whatsapp === null ? null : `https://wa.me/${whatsapp.replace(/^\+/, '')}`,
    telegramUrl: telegram === null ? null : `https://t.me/${telegram}`,
  };
}

/** PG2: the three packs whose prices the tier table shows. */
export const TIER_TABLE_PACKS = 3;

/**
 * `GET /api/merchant/tier/table` (PG2, decision 8): per tier its threshold (null: Bronze, or a
 * tier without a live level), its privileges and the prices of three packs on its list; never a
 * list's name, rule or cost.
 */
export const merchantTierTableSchema = z
  .object({
    current: merchantTierSchema,
    packs: z
      .array(z.object({ productId: z.uuid(), gameNameAr: z.string(), nameAr: z.string() }))
      .max(TIER_TABLE_PACKS),
    tiers: z.array(
      z.object({
        tier: merchantTierSchema,
        available: z.boolean(),
        thresholdUsdUnits: amountUnitsSchema.nullable(),
        privileges: tierPrivilegesSchema,
        /** In the packs' order; null where the pack has no price on the list. */
        prices: z.array(amountUnitsSchema.nullable()),
      }),
    ),
  })
  .meta({ id: 'MerchantTierTable' });

export type MerchantTierTable = z.infer<typeof merchantTierTableSchema>;

/** `GET /api/merchant/tier/history` (PG5): newest first, this month live on top. */
export const merchantTierHistorySchema = z
  .object({
    items: z.array(
      z.object({
        month: z.string(),
        netPurchasesUsdUnits: z.int(),
        tier: merchantTierSchema,
        current: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'MerchantTierHistory' });

export type MerchantTierHistory = z.infer<typeof merchantTierHistorySchema>;

/* Receipt welcome line (RC1) ----------------------------------------------------------------- */

/** RC1: 2–60 characters after trimming. */
export const WELCOME_TEXT_MAX = 60;

// No control characters. Links and contacts are read on the NFKC form, so fullwidth or other
// lookalike forms count as the plain ones: no scheme, `www`, `name.tld` (spaces around the dot
// included) or `@handle`; no run of 7 or more digits of any script, whatever separates them but
// letters, so no phone number hides in it (reviewer, S23 PR 2).
const CONTROL = /\p{Cc}|\p{Cf}/u;
const LINK =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\s*\.|[a-z0-9-]+\s*[.。．]\s*[a-z]{2,}|@[a-z0-9_]{3,})/iu;
const DIGIT_RUN = /(?:\p{Nd}[^\p{L}]*){7,}/u;

/** RC1: the receipt's welcome line. */
export const welcomeTextSchema = z
  .string()
  .trim()
  .min(2)
  .max(WELCOME_TEXT_MAX)
  .refine((text) => !CONTROL.test(text), 'Control characters are not allowed')
  .refine((text) => !LINK.test(text.normalize('NFKC')), 'Links are not allowed')
  .refine((text) => !DIGIT_RUN.test(text.normalize('NFKC')), 'Long digit runs are not allowed');

/* The Diamond best-sellers helper (PX5) ------------------------------------------------------ */

/** PX5: the packs merchants bought most, by delivered units in the last 30 days. */
export const TIER_BEST_SELLERS_LIMIT = 20;

export const TIER_BEST_SELLERS_DAYS = 30;

/**
 * `GET /api/admin/merchant-tiers/best-sellers` (PX5): the packs with their basis cost and each
 * tier's price and margin; `diamondListId` opens S20's fixed price dialog (null without a live
 * Diamond level). A price is null where the tier's list has none.
 */
export const tierBestSellersSchema = z
  .object({
    diamondListId: z.uuid().nullable(),
    items: z.array(
      z.object({
        productId: z.uuid(),
        gameId: z.uuid(),
        gameNameAr: z.string(),
        nameAr: z.string(),
        deliveredUnits: z.int().positive(),
        /** The basis route's unit cost; null with no usable route. */
        costUsdUnits: amountUnitsSchema.nullable(),
        tiers: z.array(
          z.object({
            tier: merchantTierSchema,
            priceUsdUnits: amountUnitsSchema.nullable(),
            /** Price − cost; null without both. */
            marginUsdUnits: z.int().nullable(),
            /** The row comes from a fixed price on the tier's list. */
            fixed: z.boolean(),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'MerchantTierBestSellers' });

export type TierBestSellers = z.infer<typeof tierBestSellersSchema>;

/* The report by tier (AD4) ------------------------------------------------------------------- */

/** `GET /api/admin/reports/merchant-tiers` and its export (AD4): a `YYYY-MM` month. */
export const merchantTierReportQuerySchema = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
  .meta({ id: 'MerchantTierReportQuery' });

export type MerchantTierReportQuery = z.infer<typeof merchantTierReportQuerySchema>;

/**
 * AD4: per tier, the merchants holding it at the month's end (now for the current month) and
 * their net purchases; sales, cost and profit of the month's delivered orders by the tier whose
 * list priced them (wholesale is Bronze); rises into and falls out of the tier in the month.
 * Test merchants are left out.
 */
export const merchantTierReportSchema = z
  .object({
    month: z.string(),
    /** The month is still running: holders are today's. */
    current: z.boolean(),
    generatedAt: z.iso.datetime(),
    rows: z.array(
      z.object({
        tier: merchantTierSchema,
        merchants: z.int().nonnegative(),
        netPurchasesUsdUnits: z.int(),
        delivered: z.int().nonnegative(),
        salesUsdUnits: z.int(),
        costUsdUnits: z.int(),
        profitUsdUnits: z.int(),
        rises: z.int().nonnegative(),
        falls: z.int().nonnegative(),
      }),
    ),
  })
  .meta({ id: 'MerchantTierReport' });

export type MerchantTierReport = z.infer<typeof merchantTierReportSchema>;

/**
 * AD4: a change counts as a rise into its new tier, or a fall out of its old one, when it moves up
 * or down the ladder.
 */
export function tierMove(from: MerchantTier, to: MerchantTier): 'rise' | 'fall' | null {
  const delta = tierRank(to) - tierRank(from);
  return delta > 0 ? 'rise' : delta < 0 ? 'fall' : null;
}
