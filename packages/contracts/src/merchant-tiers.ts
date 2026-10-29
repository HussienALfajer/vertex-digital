import { z } from 'zod';
import { amountUnitsSchema, CURRENCY_SCALE, isWholeCents, USD_CENT } from './money.js';
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
  .object({ items: z.array(merchantTierViewSchema) })
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
