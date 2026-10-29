import {
  type LevelTier,
  MERCHANT_TIERS,
  type MerchantTier,
  type TierChangeSource,
  type TierQuantities,
  tierOf,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  customers,
  merchantLevels,
  merchantProfiles,
  merchantTierChanges,
  merchantTierGrants,
  merchantTierSettings,
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
