import {
  accountPriceKind,
  damascusMonth,
  effectiveLevel,
  effectivePriceListId,
  isImportantTierChange,
  type LevelTier,
  levelFor,
  type MerchantTier,
  monthRange,
  previousMonth,
  QUEUES,
  TIER_NAMES_AR,
  type TierChangeSource,
  tierOf,
  tierRank,
} from '@vertex-digital/contracts';
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { lockCustomer } from '../customers/state.js';
import { findCustomerWallet } from '../ledger/wallet.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { cancelReservation } from '../orders/reservations.js';
import { queueTelegramMessage } from '../telegram/queue-telegram-message.js';
import { levelTier, liveTierLevels, openTierGrant, recordTierChange } from './tiers.js';
import {
  customers,
  ledgerJournals,
  ledgerPostings,
  merchantLevels,
  merchantProfiles,
  merchantTierMonths,
  orders,
  priceLists,
} from '../schema/index.js';

/*
 * Volume levels (S21 F39, LV1–LV7, ADR 0036): a merchant's level follows their net wallet purchases
 * of the previous and the current Damascus month; the level's list is what they pay below an
 * assigned list (LV5). One recomputation per merchant at a time (`merchants.level`, stately by
 * customer), with the customer locked `FOR NO KEY UPDATE` so it never interleaves with a purchase
 * (which reads it `FOR SHARE`).
 */

export type MerchantLevelRow = typeof merchantLevels.$inferSelect;

/** LV5: the list of the merchant's live level, or null (no level, a revoked merchant, none live). */
export async function levelListId(db: Executor, customerId: string): Promise<string | null> {
  const [row] = await db
    .select({ priceListId: merchantLevels.priceListId })
    .from(merchantProfiles)
    .innerJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .where(
      and(
        eq(merchantProfiles.customerId, customerId),
        isNull(merchantProfiles.revokedAt),
        isNull(merchantLevels.archivedAt),
      ),
    );
  return row?.priceListId ?? null;
}

/** The live levels, lowest threshold first. */
export function liveLevels(db: Executor): Promise<MerchantLevelRow[]> {
  return db
    .select()
    .from(merchantLevels)
    .where(isNull(merchantLevels.archivedAt))
    .orderBy(asc(merchantLevels.monthlyThresholdUsdUnits));
}

/**
 * LV2, DB3: the customer's net wallet purchases of `[from, to)`: the purchase debits posted in the
 * period, less the refund credits of the orders those purchases paid, whenever the refund posted
 * (Q26, audit A06-23). A refund after midnight of an order paid before it lowers the month that
 * paid it, so orders bought to fail at a month's end never keep that month's level. Owner-funded
 * orders never touch the wallet. Never negative: a refund lowers only its own purchase's month.
 */
export async function netPurchases(
  db: Executor,
  customerId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const wallet = await findCustomerWallet(db, customerId);
  if (wallet === null) return 0;
  // Every refund journal is one order's (`orders.refund_journal_id`); its month is the month of
  // that order's purchase journal (a checkout's orders share theirs).
  const refunded = alias(orders, 'refunded');
  const paidBy = alias(ledgerJournals, 'paid_by');
  const [row] = await db
    .select({ net: sql<string>`coalesce(-sum(${ledgerPostings.amountUnits}), 0)::text` })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .leftJoin(
      refunded,
      and(eq(ledgerJournals.kind, 'refund'), eq(refunded.refundJournalId, ledgerJournals.id)),
    )
    .leftJoin(paidBy, eq(paidBy.id, refunded.purchaseJournalId))
    .where(
      and(
        eq(ledgerPostings.accountId, wallet),
        inArray(ledgerJournals.kind, ['purchase', 'refund']),
        // Implied by the next condition (a refund's journal begins after its purchase's), and
        // served by `ledger_journals_created_at_idx`: the read no longer walks the wallet's whole
        // history (audit A10-47).
        gte(ledgerJournals.createdAt, from),
        gte(sql`coalesce(${paidBy.createdAt}, ${ledgerJournals.createdAt})`, from),
        lt(sql`coalesce(${paidBy.createdAt}, ${ledgerJournals.createdAt})`, to),
      ),
    );
  return Number(row?.net ?? 0);
}

/** LV2: this and the previous Damascus month's net purchases at `now`. */
export async function monthsPurchases(
  db: Executor,
  customerId: string,
  now: Date,
): Promise<{ thisMonthUsdUnits: number; previousMonthUsdUnits: number }> {
  const month = damascusMonth(now);
  const current = monthRange(month);
  const previous = monthRange(previousMonth(month));
  return {
    thisMonthUsdUnits: await netPurchases(db, customerId, current.start, current.end),
    previousMonthUsdUnits: await netPurchases(db, customerId, previous.start, previous.end),
  };
}

/**
 * LV4: queues the merchant's recomputation in the caller's transaction (one at a time); S23 TR6:
 * `tiers_changed` names a change of the tiers' thresholds or lists as its cause.
 */
export async function queueMerchantLevel(
  tx: Transaction,
  jobs: JobSender,
  customerId: string,
  cause?: 'tiers_changed',
) {
  await jobs.send(
    tx,
    QUEUES.merchantsLevel,
    cause === undefined ? { customerId } : { customerId, cause },
    { singletonKey: customerId, retryLimit: 3, retryDelay: 30, retryBackoff: true },
  );
}

/** LV4: queues the recomputation when the customer is a merchant (after a purchase or a refund). */
export async function queueMerchantLevelIfMerchant(
  tx: Transaction,
  jobs: JobSender,
  customerId: string,
): Promise<void> {
  const [row] = await tx
    .select({ accountType: customers.accountType })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (row?.accountType === 'merchant') await queueMerchantLevel(tx, jobs, customerId);
}

/** LV4, LV6: every merchant's recomputation (the monthly cron, a tier change in the panel). */
export async function queueAllMerchantLevels(
  tx: Transaction,
  jobs: JobSender,
  cause?: 'tiers_changed',
): Promise<number> {
  const rows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.accountType, 'merchant'), isNull(customers.archivedAt)))
    .orderBy(asc(customers.id));
  for (const row of rows) await queueMerchantLevel(tx, jobs, row.id, cause);
  return rows.length;
}

export type LevelChange =
  | { changed: false }
  | {
      changed: true;
      levelIdBefore: string | null;
      levelIdAfter: string | null;
      tierBefore: MerchantTier;
      tierAfter: MerchantTier;
      listChanged: boolean;
      cancelledOrderIds: string[];
    };

/** What a recomputation is told about its cause (S23 TR6); by default the purchases or the grant. */
export interface RecomputeContext {
  jobs: JobSender;
  now: Date;
  /** The change row's source when the tier changes; `earned` or `granted` by default. */
  cause?: TierChangeSource;
}

/**
 * LV3, LV4, S23 TR6: recomputes one merchant's earned and effective level in the caller's
 * transaction. The customer is locked `FOR NO KEY UPDATE`; a customer who is not a merchant, or a
 * revoked profile, has none. The effective level is the higher of the earned level and the open
 * grant's tier (TR3). When either differs: the profile's levels and source (and the time, when the
 * effective level changed) and the audit entry (system actor); when the effective tier changed, the
 * change row, the `merchant_level_changed` notification and, for a change into or out of Gold or
 * Diamond, the Telegram alert (TR8). Every run cancels the reservations on a list the account no
 * longer pays (S20 AT3), so an archived level or a level's new list moves them too (LV6). The same
 * state twice writes nothing.
 */
export async function recomputeMerchantLevel(
  tx: Transaction,
  context: RecomputeContext,
  customerId: string,
): Promise<LevelChange> {
  const customer = await lockCustomer(tx, customerId);
  const [profile] = await tx
    .select({
      levelId: merchantProfiles.levelId,
      earnedLevelId: merchantProfiles.earnedLevelId,
      levelSource: merchantProfiles.levelSource,
      revokedAt: merchantProfiles.revokedAt,
      tradeName: merchantProfiles.tradeName,
    })
    .from(merchantProfiles)
    .where(eq(merchantProfiles.customerId, customerId));
  if (!profile) return { changed: false };
  const merchant = customer.accountType === 'merchant' && profile.revokedAt === null;
  const levels = await liveTierLevels(tx);
  const months = await monthsPurchases(tx, customerId, context.now);
  const grant = merchant ? await openTierGrant(tx, customerId) : null;
  const earned = merchant
    ? levelFor(levels, months.previousMonthUsdUnits, months.thisMonthUsdUnits)
    : null;
  // A grant never carries Bronze (`merchant_tier_grants_check`).
  const effective = effectiveLevel(earned, (grant?.tier ?? null) as LevelTier | null, levels);
  const levelIdAfter = effective.level?.id ?? null;
  const earnedLevelIdAfter = earned?.id ?? null;
  // The profile's level as it was, archived or not: its list and tier are what changes.
  const [before] =
    profile.levelId === null
      ? []
      : await tx.select().from(merchantLevels).where(eq(merchantLevels.id, profile.levelId));
  const listAfter = effectivePriceListId({
    ...customer,
    levelListId: effective.level?.priceListId,
  });
  // AT3: a reservation is never left on a list the account no longer pays, whether the level
  // changed or the level's list did (LV6: an archive, an edit of the list).
  const cancelledOrderIds = await cancelReservationsOffList(tx, context, customerId, listAfter);
  if (
    levelIdAfter === profile.levelId &&
    earnedLevelIdAfter === profile.earnedLevelId &&
    effective.source === profile.levelSource
  ) {
    return { changed: false };
  }

  const levelChanged = levelIdAfter !== profile.levelId;
  await tx
    .update(merchantProfiles)
    .set({
      levelId: levelIdAfter,
      earnedLevelId: earnedLevelIdAfter,
      levelSource: effective.source,
      ...(levelChanged ? { levelChangedAt: context.now } : {}),
    })
    .where(eq(merchantProfiles.customerId, customerId));
  const listBefore = effectivePriceListId({ ...customer, levelListId: before?.priceListId });
  const listChanged = listBefore !== listAfter;
  const tierBefore = levelTier(before);
  const tierAfter = tierOf(effective.level);
  await recordAudit(tx, {
    action: 'merchant.level_changed',
    actorKind: 'system',
    actorId: null,
    channel: 'worker',
    entityType: 'customer',
    entityId: customerId,
    details: {
      levelIdBefore: profile.levelId,
      levelIdAfter,
      previousMonthUsdUnits: months.previousMonthUsdUnits,
      thisMonthUsdUnits: months.thisMonthUsdUnits,
      listChanged,
      cancelledOrderIds,
      tierBefore,
      tierAfter,
      earnedLevelIdAfter,
      source: effective.source,
    },
  });
  if (tierBefore !== tierAfter) {
    const source = context.cause ?? (effective.source === 'granted' ? 'granted' : 'earned');
    const changeId = await recordTierChange(tx, {
      customerId,
      from: tierBefore,
      to: tierAfter,
      source,
    });
    // A revocation tells the customer and the admin itself (TR9).
    if (merchant) {
      const [list] = await tx
        .select({ kind: priceLists.kind })
        .from(priceLists)
        .where(eq(priceLists.id, listAfter));
      if (!list) throw new Error(`Price list ${listAfter} does not exist`);
      await notifyCustomer(tx, context.jobs, {
        customerId,
        event: 'merchant_level_changed',
        params: {
          levelNameAr: tierAfter === 'bronze' ? null : TIER_NAMES_AR[tierAfter],
          priceKind: accountPriceKind(
            list.kind,
            customer.priceListId === null && effective.level !== null,
          ),
          direction: tierRank(tierAfter) > tierRank(tierBefore) ? 'up' : 'down',
          tier: tierAfter,
        },
      });
      if (isImportantTierChange(tierBefore, tierAfter)) {
        await queueTelegramMessage(tx, context.jobs, {
          kind: 'merchant_tier_changed',
          params: {
            customerId,
            tradeName: profile.tradeName,
            from: tierBefore,
            to: tierAfter,
            source,
            thisMonthUsdUnits: months.thisMonthUsdUnits,
            previousMonthUsdUnits: months.previousMonthUsdUnits,
          },
          dedupeKey: `tier-change:${customerId}:${changeId}`,
        });
      }
    }
  }
  return {
    changed: true,
    levelIdBefore: profile.levelId,
    levelIdAfter,
    tierBefore,
    tierAfter,
    listChanged,
    cancelledOrderIds,
  };
}

/**
 * S23 PG5: the merchant's row for `month` (`YYYY-MM`, the month just ended), written by the monthly
 * schedule after the merchant's recomputation: the month's net purchases, the tier they earned at
 * its end (LV3 on it and the month before) and the tier held now. Once: a second run writes
 * nothing. Returns whether it wrote.
 */
export async function recordTierMonth(
  tx: Transaction,
  customerId: string,
  month: string,
): Promise<boolean> {
  const range = monthRange(month);
  const before = monthRange(previousMonth(month));
  const net = await netPurchases(tx, customerId, range.start, range.end);
  const previousNet = await netPurchases(tx, customerId, before.start, before.end);
  const levels = await liveTierLevels(tx);
  const [profile] = await tx
    .select({
      revokedAt: merchantProfiles.revokedAt,
      levelSource: merchantProfiles.levelSource,
      tier: merchantLevels.tier,
      archivedAt: merchantLevels.archivedAt,
    })
    .from(merchantProfiles)
    .leftJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .where(eq(merchantProfiles.customerId, customerId));
  if (!profile) return false;
  const held =
    profile.revokedAt === null && profile.archivedAt === null ? levelTier(profile) : 'bronze';
  const rows = await tx
    .insert(merchantTierMonths)
    .values({
      customerId,
      month: `${month}-01`,
      netPurchasesUsdUnits: net,
      earnedTier: tierOf(levelFor(levels, previousNet, net)),
      heldTier: held,
      heldSource: held === 'bronze' ? 'earned' : (profile.levelSource ?? 'earned'),
    })
    .onConflictDoNothing()
    .returning({ customerId: merchantTierMonths.customerId });
  return rows.length > 0;
}

/** AT3: the account's reservations on any list but `priceListId`, cancelled in id order. */
async function cancelReservationsOffList(
  tx: Transaction,
  context: { jobs: JobSender },
  customerId: string,
  priceListId: string,
): Promise<string[]> {
  const reserved = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(orders.status, 'awaiting_balance'),
        ne(orders.priceListId, priceListId),
      ),
    )
    .orderBy(asc(orders.id))
    .for('update');
  const cancelled: string[] = [];
  for (const order of reserved) {
    const done = await cancelReservation(tx, context, order, 'price_list_changed', {
      kind: 'system',
    });
    if (done) cancelled.push(done.id);
  }
  return cancelled;
}

/** S20 LS5 extended (S21 LV6): the live levels naming a list, which keep it from an archive. */
export async function liveLevelsOnList(db: Executor, priceListId: string): Promise<number> {
  const rows = await db
    .select({ id: merchantLevels.id })
    .from(merchantLevels)
    .where(and(eq(merchantLevels.priceListId, priceListId), isNull(merchantLevels.archivedAt)));
  return rows.length;
}

/** DB5: the merchant's live level by name, or null. */
export async function merchantLevelOf(
  db: Executor,
  customerId: string,
): Promise<{ id: string; nameAr: string } | null> {
  const [row] = await db
    .select({ id: merchantLevels.id, nameAr: merchantLevels.nameAr })
    .from(merchantProfiles)
    .innerJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .where(
      and(
        eq(merchantProfiles.customerId, customerId),
        isNull(merchantProfiles.revokedAt),
        isNull(merchantLevels.archivedAt),
      ),
    );
  return row ?? null;
}

/** LV1: every level with its list and the merchants on it, live levels first by threshold. */
export function levelRows(db: Executor) {
  return db
    .select({
      level: merchantLevels,
      list: { id: priceLists.id, name: priceLists.name, kind: priceLists.kind },
      merchants: sql<number>`(select count(*)::int from ${merchantProfiles}
        where ${merchantProfiles.levelId} = ${merchantLevels.id}
          and ${merchantProfiles.revokedAt} is null)`,
    })
    .from(merchantLevels)
    .innerJoin(priceLists, eq(priceLists.id, merchantLevels.priceListId))
    .orderBy(
      sql`${merchantLevels.archivedAt} is not null`,
      asc(merchantLevels.monthlyThresholdUsdUnits),
      asc(merchantLevels.id),
    );
}
