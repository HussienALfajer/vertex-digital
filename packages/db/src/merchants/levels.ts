import {
  damascusMonth,
  effectivePriceListId,
  levelFor,
  monthRange,
  previousMonth,
  priceKindOf,
  QUEUES,
} from '@vertex-digital/contracts';
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { lockCustomer } from '../customers/state.js';
import { findCustomerWallet } from '../ledger/wallet.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { cancelReservation } from '../orders/reservations.js';
import {
  customers,
  ledgerJournals,
  ledgerPostings,
  merchantLevels,
  merchantProfiles,
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

/** LV4: queues the merchant's recomputation in the caller's transaction (one at a time). */
export async function queueMerchantLevel(tx: Transaction, jobs: JobSender, customerId: string) {
  await jobs.send(
    tx,
    QUEUES.merchantsLevel,
    { customerId },
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

/** LV4, LV6: every merchant's recomputation (the monthly cron, a level change in the panel). */
export async function queueAllMerchantLevels(tx: Transaction, jobs: JobSender): Promise<number> {
  const rows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.accountType, 'merchant'), isNull(customers.archivedAt)))
    .orderBy(asc(customers.id));
  for (const row of rows) await queueMerchantLevel(tx, jobs, row.id);
  return rows.length;
}

export type LevelChange =
  | { changed: false }
  | {
      changed: true;
      levelIdBefore: string | null;
      levelIdAfter: string | null;
      listChanged: boolean;
      cancelledOrderIds: string[];
    };

/**
 * LV3, LV4: recomputes one merchant's level in the caller's transaction. The customer is locked
 * `FOR NO KEY UPDATE`; a customer who is not a merchant, or a revoked profile, has no level. When
 * the level differs: the profile's level and time, the audit entry (system actor) and the
 * `merchant_level_changed` notification. Every run cancels the reservations on a list the account
 * no longer pays (S20 AT3), so an archived level or a level's new list moves them too (LV6). The
 * same state twice writes nothing.
 */
export async function recomputeMerchantLevel(
  tx: Transaction,
  context: { jobs: JobSender; now: Date },
  customerId: string,
): Promise<LevelChange> {
  const customer = await lockCustomer(tx, customerId);
  const [profile] = await tx
    .select({ levelId: merchantProfiles.levelId, revokedAt: merchantProfiles.revokedAt })
    .from(merchantProfiles)
    .where(eq(merchantProfiles.customerId, customerId));
  if (!profile) return { changed: false };
  const merchant = customer.accountType === 'merchant' && profile.revokedAt === null;
  const levels = await liveLevels(tx);
  const months = await monthsPurchases(tx, customerId, context.now);
  const level = merchant
    ? levelFor(levels, months.previousMonthUsdUnits, months.thisMonthUsdUnits)
    : null;
  const levelIdAfter = level?.id ?? null;
  // The profile's level as it was, archived or not: its list and threshold are what changes.
  const [before] =
    profile.levelId === null
      ? []
      : await tx.select().from(merchantLevels).where(eq(merchantLevels.id, profile.levelId));
  const listAfter = effectivePriceListId({ ...customer, levelListId: level?.priceListId });
  // AT3: a reservation is never left on a list the account no longer pays, whether the level
  // changed or the level's list did (LV6: an archive, an edit of the list).
  const cancelledOrderIds = await cancelReservationsOffList(tx, context, customerId, listAfter);
  if (levelIdAfter === profile.levelId) return { changed: false };

  await tx
    .update(merchantProfiles)
    .set({ levelId: levelIdAfter, levelChangedAt: context.now })
    .where(eq(merchantProfiles.customerId, customerId));
  const listBefore = effectivePriceListId({ ...customer, levelListId: before?.priceListId });
  const listChanged = listBefore !== listAfter;
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
    },
  });
  if (merchant) {
    const [list] = await tx
      .select({ kind: priceLists.kind })
      .from(priceLists)
      .where(eq(priceLists.id, listAfter));
    if (!list) throw new Error(`Price list ${listAfter} does not exist`);
    const rank = (threshold: number | undefined) => threshold ?? 0;
    await notifyCustomer(tx, context.jobs, {
      customerId,
      event: 'merchant_level_changed',
      params: {
        levelNameAr: level?.nameAr ?? null,
        priceKind: priceKindOf(list.kind),
        direction:
          rank(level?.monthlyThresholdUsdUnits) > rank(before?.monthlyThresholdUsdUnits)
            ? 'up'
            : 'down',
      },
    });
  }
  return {
    changed: true,
    levelIdBefore: profile.levelId,
    levelIdAfter,
    listChanged,
    cancelledOrderIds,
  };
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
