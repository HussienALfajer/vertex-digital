import {
  ALERT_EVENTS_KEEP_DAYS,
  type AlertKind,
  type AlertLine,
  alertCounts,
  MERCHANT_DAILY_DIGEST_LINES,
  WATCH_DIGEST_LINES,
  watchChanges,
} from '@vertex-digital/contracts';
import { and, asc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { type JobSender, notifyCustomer, queueEmail } from '../notifications/index.js';
import type { RoutingContext } from '../pricing/index.js';
import {
  catalogGames,
  catalogProducts,
  customerNotifications,
  customers,
  emailOutbox,
  merchantAlertEvents,
  merchantAlertSettings,
  merchantWatches,
  merchantWatchStates,
} from '../schema/index.js';
import { clearLowBalanceIfAbove } from './alerts.js';
import { alertEvents, merchantListPrices, watchedProductIds } from './reads.js';

const HOUR = 60 * 60 * 1000;

/** S23 OP8: a merchant of a tier with faster alerts is told at most once a quarter hour. */
export const FAST_ALERTS_WINDOW_MS = 15 * 60 * 1000;

/*
 * The hourly follow alerts (S21 AL2, AL3, AL6) and the daily email (AL4). One merchant per
 * transaction, under a per-merchant advisory lock taken without waiting: a second run in the same
 * hour skips a merchant being compared, then finds no difference.
 */

/** Merchants with at least one follow, or an alert threshold to clear (AL6). */
export async function merchantsToCompare(db: Executor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.accountType, 'merchant'),
        sql`${customers.archivedAt} is null`,
        or(
          sql`exists (select 1 from ${merchantWatches} where ${merchantWatches.customerId} = ${customers.id})`,
          sql`exists (select 1 from ${merchantAlertSettings} where ${merchantAlertSettings.customerId} = ${customers.id} and ${merchantAlertSettings.lowBalanceAlertedAt} is not null)`,
        ),
      ),
    )
    .orderBy(asc(customers.id));
  return rows.map((row) => row.id);
}

/**
 * AL2, AL3, AL6 for one merchant in the caller's transaction: follows of archived products
 * dropped (edge case 18), each followed product compared with what was last told (hidden products
 * ignored, a first sight only recorded), the events written, one digest notification when there
 * are any and none was written this hour, and a sent low-balance alert cleared once the balance is
 * back. Null when another run holds the merchant. S23 OP8: `digestWindowMs` is the digest's
 * dedupe window, an hour by default and a quarter hour for a tier with faster alerts.
 */
export async function compareMerchantWatches(
  tx: Transaction,
  context: RoutingContext & { jobs: JobSender; digestWindowMs?: number },
  customerId: string,
): Promise<{ events: number } | null> {
  const [locked] = (
    await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`watch-alerts:${customerId}`})) as locked`,
    )
  ).rows;
  if (!locked?.locked) return null;

  await tx
    .delete(merchantWatches)
    .where(
      and(
        eq(merchantWatches.customerId, customerId),
        isNotNull(merchantWatches.productId),
        inArray(
          merchantWatches.productId,
          tx
            .select({ id: catalogProducts.id })
            .from(catalogProducts)
            .where(isNotNull(catalogProducts.archivedAt)),
        ),
      ),
    );
  const productIds = await watchedProductIds(tx, customerId);
  const prices = await merchantListPrices(tx, customerId, productIds, context);
  const told = new Map(
    (productIds.length === 0
      ? []
      : await tx
          .select()
          .from(merchantWatchStates)
          .where(
            and(
              eq(merchantWatchStates.customerId, customerId),
              inArray(merchantWatchStates.productId, productIds),
            ),
          )
    ).map((row) => [row.productId, row]),
  );

  const kinds: AlertKind[] = [];
  const lines: AlertLine[] = [];
  const names = await productNames(tx, productIds);
  for (const productId of productIds) {
    const price = prices.get(productId);
    if (!price || price.availability === 'hidden') continue;
    const now = { priceUsdUnits: price.priceUsdUnits, available: price.priceUsdUnits !== null };
    const before = told.get(productId);
    const changes = before ? watchChanges(before, now) : [];
    if (before && changes.length === 0) continue;
    for (const kind of changes) {
      const priceChange = kind === 'price_down' || kind === 'price_up';
      const line: AlertLine = {
        productId,
        gameNameAr: names.get(productId)?.gameNameAr ?? '',
        productNameAr: names.get(productId)?.nameAr ?? '',
        kind,
        oldPriceUsdUnits: priceChange ? (before?.priceUsdUnits ?? null) : null,
        newPriceUsdUnits: priceChange ? now.priceUsdUnits : null,
      };
      await tx.insert(merchantAlertEvents).values({
        customerId,
        productId,
        kind,
        oldPriceUsdUnits: line.oldPriceUsdUnits,
        newPriceUsdUnits: line.newPriceUsdUnits,
      });
      kinds.push(kind);
      lines.push(line);
    }
    // A price that went away keeps the last one told, so its return compares with it.
    const state = {
      priceUsdUnits: now.priceUsdUnits ?? before?.priceUsdUnits ?? null,
      available: now.available,
      toldAt: sql`now()`,
    };
    await tx
      .insert(merchantWatchStates)
      .values({ customerId, productId, ...state })
      .onConflictDoUpdate({
        target: [merchantWatchStates.customerId, merchantWatchStates.productId],
        set: state,
      });
  }
  if (
    kinds.length > 0 &&
    !(await digestSentInWindow(tx, customerId, context.now, context.digestWindowMs ?? HOUR))
  ) {
    const counts = alertCounts(kinds);
    await notifyCustomer(tx, context.jobs, {
      customerId,
      event: 'merchant_watch_digest',
      params: {
        priceDown: counts.price_down,
        priceUp: counts.price_up,
        backInStock: counts.back_in_stock,
        outOfStock: counts.out_of_stock,
        lines: lines.slice(0, WATCH_DIGEST_LINES),
      },
    });
  }
  await clearLowBalanceIfAbove(tx, customerId);
  return { events: kinds.length };
}

/**
 * AL3's dedupe `watch-digest:<customer>:<hour>` (audit A06-37): a digest already written this hour
 * (S23 OP8: this quarter hour for faster alerts), read under the merchant's advisory lock, so a
 * manual run after the cron sends no second one. The events are still written and shown on the
 * alerts page.
 */
async function digestSentInWindow(
  tx: Transaction,
  customerId: string,
  now: Date,
  windowMs: number,
) {
  const hour = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [sent] = await tx
    .select({ id: customerNotifications.id })
    .from(customerNotifications)
    .where(
      and(
        eq(customerNotifications.customerId, customerId),
        eq(customerNotifications.event, 'merchant_watch_digest'),
        gte(customerNotifications.createdAt, hour),
      ),
    )
    .limit(1);
  return sent !== undefined;
}

async function productNames(db: Executor, productIds: readonly string[]) {
  if (productIds.length === 0) return new Map<string, { nameAr: string; gameNameAr: string }>();
  const rows = await db
    .select({
      id: catalogProducts.id,
      nameAr: catalogProducts.nameAr,
      gameNameAr: catalogGames.nameAr,
    })
    .from(catalogProducts)
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(inArray(catalogProducts.id, [...productIds]));
  return new Map(rows.map((row) => [row.id, row]));
}

/** AL4: merchants who turned the daily email on. */
export async function dailyDigestMerchants(db: Executor): Promise<string[]> {
  const rows = await db
    .select({ id: customers.id })
    .from(merchantAlertSettings)
    .innerJoin(customers, eq(customers.id, merchantAlertSettings.customerId))
    .where(
      and(
        eq(merchantAlertSettings.dailyEmail, true),
        eq(customers.accountType, 'merchant'),
        sql`${customers.archivedAt} is null`,
      ),
    )
    .orderBy(asc(customers.id));
  return rows.map((row) => row.id);
}

/**
 * AL4 for one merchant: the email of the last 24 hours' events, at most one a day (a digest queued
 * in the last 20 hours means this run already sent it). False without events.
 */
export async function sendDailyDigest(
  tx: Transaction,
  context: { jobs: JobSender; now: Date },
  customerId: string,
): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`daily-digest:${customerId}`}))`);
  const [sent] = await tx
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.template, 'customer_merchant_daily_digest'),
        eq(emailOutbox.customerId, customerId),
        gte(emailOutbox.createdAt, new Date(context.now.getTime() - 20 * 60 * 60 * 1000)),
      ),
    )
    .limit(1);
  if (sent) return false;
  const events = await alertEvents(tx, customerId, {
    since: new Date(context.now.getTime() - 24 * 60 * 60 * 1000),
    limit: 10_000,
  });
  if (events.length === 0) return false;
  const [customer] = await tx
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return false;
  await queueEmail(tx, context.jobs, {
    to: customer.email,
    template: 'customer_merchant_daily_digest',
    customerId,
    params: {
      total: events.length,
      lines: events.slice(0, MERCHANT_DAILY_DIGEST_LINES).map((event) => ({
        productId: event.productId,
        gameNameAr: event.gameNameAr,
        productNameAr: event.productNameAr,
        kind: event.kind,
        oldPriceUsdUnits: event.oldPriceUsdUnits,
        newPriceUsdUnits: event.newPriceUsdUnits,
      })),
    },
  });
  return true;
}

/** The sweep: alert events older than 90 days (the guard refuses younger ones). */
export async function deleteOldAlertEvents(db: Executor): Promise<number> {
  const deleted = await db
    .delete(merchantAlertEvents)
    .where(
      lt(
        merchantAlertEvents.createdAt,
        sql`now() - ${`${ALERT_EVENTS_KEEP_DAYS} days`}::interval - interval '1 minute'`,
      ),
    )
    .returning({ id: merchantAlertEvents.id });
  return deleted.length;
}
