import {
  type LevelTier,
  MERCHANT_TIERS,
  type MerchantTier,
  type TierChangeSource,
  type TierPrivileges,
  type TierQuantities,
  tierOf,
} from '@vertex-digital/contracts';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  customers,
  merchantLevels,
  merchantProfiles,
  merchantTierChanges,
  merchantTierGrants,
  merchantTierSettings,
  priceLists,
} from '../schema/index.js';

/*
 * Merchant tiers (S23 F43, ADR 0038): the tier settings in force, a merchant's effective tier and
 * its privileges, the open grant and the change rows. Bronze is a merchant without an effective
 * level; the other tiers are the live levels' (`merchant_levels.tier`).
 */

export type TierSettingsRow = typeof merchantTierSettings.$inferSelect;
export type TierGrantRow = typeof merchantTierGrants.$inferSelect;

/** A live level with its tier (every live level carries one, `merchant_levels_tier_check`). */
export interface LiveTierLevel {
  id: string;
  tier: LevelTier;
  monthlyThresholdUsdUnits: number;
  priceListId: string;
}

/** TR1: the live levels with their tiers, lowest threshold first. */
export async function liveTierLevels(db: Executor): Promise<LiveTierLevel[]> {
  const rows = await db
    .select({
      id: merchantLevels.id,
      tier: merchantLevels.tier,
      monthlyThresholdUsdUnits: merchantLevels.monthlyThresholdUsdUnits,
      priceListId: merchantLevels.priceListId,
    })
    .from(merchantLevels)
    .where(isNull(merchantLevels.archivedAt))
    .orderBy(asc(merchantLevels.monthlyThresholdUsdUnits));
  return rows.map((row) => ({ ...row, tier: row.tier as LevelTier }));
}

/** TS1: the settings in force of every tier (the newest row of each, seeded by migration 0105). */
export async function currentTierSettings(
  db: Executor,
): Promise<Record<MerchantTier, TierSettingsRow>> {
  const rows = await db
    .selectDistinctOn([merchantTierSettings.tier])
    .from(merchantTierSettings)
    .orderBy(
      merchantTierSettings.tier,
      desc(merchantTierSettings.createdAt),
      desc(merchantTierSettings.id),
    );
  const byTier = new Map(rows.map((row) => [row.tier, row]));
  return Object.fromEntries(
    MERCHANT_TIERS.map((tier) => {
      const row = byTier.get(tier);
      if (!row) throw new Error(`The ${tier} tier settings are not seeded`);
      return [tier, row];
    }),
  ) as Record<MerchantTier, TierSettingsRow>;
}

/**
 * TR3: a merchant's effective tier, from the profile's level when it is live and the profile not
 * revoked; Bronze otherwise. Null for an account that is not a merchant.
 */
export async function merchantTier(db: Executor, customerId: string): Promise<MerchantTier | null> {
  const [row] = await db
    .select({
      accountType: customers.accountType,
      revokedAt: merchantProfiles.revokedAt,
      tier: merchantLevels.tier,
      archivedAt: merchantLevels.archivedAt,
    })
    .from(customers)
    .leftJoin(merchantProfiles, eq(merchantProfiles.customerId, customers.id))
    .leftJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .where(eq(customers.id, customerId));
  if (row?.accountType !== 'merchant') return null;
  if (row.revokedAt !== null || row.archivedAt !== null) return 'bronze';
  return row.tier ?? 'bronze';
}

/** TR5: the merchant's tier and its settings in force; null for an account that is not a merchant. */
export async function merchantPrivileges(
  db: Executor,
  customerId: string,
): Promise<{ tier: MerchantTier; settings: TierSettingsRow } | null> {
  const tier = await merchantTier(db, customerId);
  if (tier === null) return null;
  const [settings] = await db
    .select()
    .from(merchantTierSettings)
    .where(eq(merchantTierSettings.tier, tier))
    .orderBy(desc(merchantTierSettings.createdAt), desc(merchantTierSettings.id))
    .limit(1);
  if (!settings) throw new Error(`The ${tier} tier settings are not seeded`);
  return { tier, settings };
}

/** TS2: a settings row's privileges, as the admin's tiers page and the merchant read them. */
export function tierPrivileges(row: TierSettingsRow): TierPrivileges {
  return {
    perDepositUsdUnits: row.perDepositUsdUnits,
    dailyDepositUsdUnits: row.dailyDepositUsdUnits,
    playerChecksPerHour: row.playerChecksPerHour,
    playerChecksPerDay: row.playerChecksPerDay,
    bulkLinesMax: row.bulkLinesMax,
    orderUnitsMax: row.orderUnitsMax,
    depositPriority: row.depositPriority,
    supportPriority: row.supportPriority,
    supportReplyMinutes: row.supportReplyMinutes,
    directContact: row.directContact,
    earlyAccess: row.earlyAccess,
    fastAlerts: row.fastAlerts,
    receiptWelcome: row.receiptWelcome,
    receiptLargeLogo: row.receiptLargeLogo,
  };
}

/** TS5: a tier's quantities. */
export function tierQuantities(settings: TierSettingsRow): TierQuantities {
  return { orderUnitsMax: settings.orderUnitsMax, bulkLinesMax: settings.bulkLinesMax };
}

/** MG1: the customer's open grant, or null; `lock` takes it `FOR UPDATE`. */
export async function openTierGrant(
  db: Executor,
  customerId: string,
  lock = false,
): Promise<TierGrantRow | null> {
  const query = db
    .select()
    .from(merchantTierGrants)
    .where(and(eq(merchantTierGrants.customerId, customerId), isNull(merchantTierGrants.endedAt)));
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

/** TR6: one change of a merchant's effective tier; returns its id. */
export async function recordTierChange(
  tx: Transaction,
  change: { customerId: string; from: MerchantTier; to: MerchantTier; source: TierChangeSource },
): Promise<string> {
  const id = newId();
  await tx.insert(merchantTierChanges).values({
    id,
    customerId: change.customerId,
    fromTier: change.from,
    toTier: change.to,
    source: change.source,
  });
  return id;
}

/** The tier of a level row, archived or not (a level archived before S23 has none: Bronze). */
export function levelTier(level: { tier: MerchantTier | null } | null | undefined): MerchantTier {
  return level?.tier ?? tierOf(null);
}

/** AD5: the customer's grants, newest first. */
export function tierGrantRows(db: Executor, customerId: string): Promise<TierGrantRow[]> {
  return db
    .select()
    .from(merchantTierGrants)
    .where(eq(merchantTierGrants.customerId, customerId))
    .orderBy(desc(merchantTierGrants.startsAt), desc(merchantTierGrants.id));
}

/**
 * AD2: the merchants holding each tier now, by source: granted, not revoked merchants; Bronze is
 * every one without a live effective level.
 */
export async function tierMerchantCounts(
  db: Executor,
): Promise<Record<MerchantTier, { earned: number; granted: number }>> {
  const rows = await db
    .select({
      tier: sql<MerchantTier>`coalesce(${merchantLevels.tier}, 'bronze')`,
      granted: sql<boolean>`${merchantLevels.tier} is not null and ${merchantProfiles.levelSource} = 'granted'`,
      count: count(),
    })
    .from(merchantProfiles)
    .innerJoin(customers, eq(customers.id, merchantProfiles.customerId))
    .leftJoin(
      merchantLevels,
      and(eq(merchantLevels.id, merchantProfiles.levelId), isNull(merchantLevels.archivedAt)),
    )
    .where(and(eq(customers.accountType, 'merchant'), isNull(merchantProfiles.revokedAt)))
    .groupBy(sql`1`, sql`2`);
  const counts = Object.fromEntries(
    MERCHANT_TIERS.map((tier) => [tier, { earned: 0, granted: 0 }]),
  ) as Record<MerchantTier, { earned: number; granted: number }>;
  for (const row of rows) counts[row.tier][row.granted ? 'granted' : 'earned'] += row.count;
  return counts;
}

/** AD2: the lists a tier page names, by id (archived ones too). */
export async function tierListRefs(
  db: Executor,
  ids: readonly string[],
): Promise<
  Map<
    string,
    { id: string; name: string; parentListId: string | null; archived: boolean; kind: string }
  >
> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: priceLists.id,
      name: priceLists.name,
      kind: priceLists.kind,
      parentListId: priceLists.parentListId,
      archivedAt: priceLists.archivedAt,
    })
    .from(priceLists)
    .where(inArray(priceLists.id, [...new Set(ids)]));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        kind: row.kind,
        parentListId: row.parentListId,
        archived: row.archivedAt !== null,
      },
    ]),
  );
}

/** MG7: the open grants of a tier, by customer id (the order their locks are taken in). */
export function openGrantsOfTier(db: Executor, tier: LevelTier): Promise<TierGrantRow[]> {
  return db
    .select()
    .from(merchantTierGrants)
    .where(and(eq(merchantTierGrants.tier, tier), isNull(merchantTierGrants.endedAt)))
    .orderBy(asc(merchantTierGrants.customerId));
}

/** AD3: every granted, not revoked merchant with their trade name and earned tier. */
export async function tierMerchants(
  db: Executor,
): Promise<{ customerId: string; tradeName: string; earnedTier: MerchantTier }[]> {
  const rows = await db
    .select({
      customerId: merchantProfiles.customerId,
      tradeName: merchantProfiles.tradeName,
      tier: merchantLevels.tier,
    })
    .from(merchantProfiles)
    .innerJoin(customers, eq(customers.id, merchantProfiles.customerId))
    .leftJoin(
      merchantLevels,
      and(eq(merchantLevels.id, merchantProfiles.earnedLevelId), isNull(merchantLevels.archivedAt)),
    )
    .where(
      and(
        eq(customers.accountType, 'merchant'),
        isNull(customers.archivedAt),
        isNull(merchantProfiles.revokedAt),
      ),
    )
    .orderBy(asc(merchantProfiles.tradeName), asc(merchantProfiles.customerId));
  return rows.map((row) => ({
    customerId: row.customerId,
    tradeName: row.tradeName,
    earnedTier: row.tier ?? 'bronze',
  }));
}
