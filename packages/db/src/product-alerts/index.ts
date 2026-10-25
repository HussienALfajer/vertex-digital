import {
  alertDue,
  type CreateProductAlert,
  catalogImagePath,
  type ErrorCode,
  PRODUCT_ALERT_DAYS,
  PRODUCT_ALERT_RETENTION_DAYS,
  PRODUCT_ALERTS_BATCH,
  PRODUCT_ALERTS_ENDED_SHOWN,
  PRODUCT_ALERTS_MAX,
  type ProductAlert,
  type ProductAlertListQuery,
  productAlertRefusal,
} from '@vertex-digital/contracts';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { accountPriceList } from '../customers/price-lists.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { productRoutingStates, type RoutingContext } from '../pricing/index.js';
import {
  catalogGames,
  catalogProducts,
  customers,
  productAlerts,
  storedFiles,
} from '../schema/index.js';

/*
 * Availability and price-drop alerts (S22 F42, ADR 0037), owned by the api `catalog` module and
 * sent by the worker's `catalog.product-alerts`. An alert reads the pack on the customer's own
 * effective list (PA1, PA3), is sent once under its row lock (PA4), moves silently to a new list
 * (PA5), or ends without sending (PA6). No money moves.
 */

/** A refusal the API answers with its code (PA1). */
export class ProductAlertError extends Error {
  constructor(
    readonly code: Extract<
      ErrorCode,
      'NOT_FOUND' | 'PRODUCT_ALERT_INVALID' | 'PRODUCT_ALERTS_LIMIT_REACHED'
    >,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface PackOnList {
  /** A paused game or an archived pack, game or category: the store does not show it. */
  hidden: boolean;
  available: boolean;
  /** The unit price on the list while the pack is available; null otherwise. */
  unitPriceUsdUnits: number | null;
}

/** The packs as a list's customer sees them now (S09 SF1, S20 PO1). */
async function packsOnList(
  db: Executor,
  productIds: readonly string[],
  priceListId: string,
  context: RoutingContext,
): Promise<Map<string, PackOnList>> {
  const packs = new Map<string, PackOnList>();
  if (productIds.length === 0) return packs;
  const states = await productRoutingStates(db, productIds, context, priceListId);
  const games = await db
    .select({ productId: catalogProducts.id, gameStatus: catalogGames.status })
    .from(catalogProducts)
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(inArray(catalogProducts.id, [...states.keys()]));
  const paused = new Set(
    games.filter((row) => row.gameStatus === 'paused').map((row) => row.productId),
  );
  for (const [productId, state] of states) {
    const available = state.availability === 'available';
    packs.set(productId, {
      hidden: state.availability === 'hidden' || paused.has(productId),
      available,
      unitPriceUsdUnits: available ? (state.current?.priceUsdUnits ?? null) : null,
    });
  }
  return packs;
}

const alertColumns = {
  id: productAlerts.id,
  kind: productAlerts.kind,
  status: productAlerts.status,
  baselinePriceUsdUnits: productAlerts.baselinePriceUsdUnits,
  expiresAt: productAlerts.expiresAt,
  sentAt: productAlerts.sentAt,
  endedAt: productAlerts.endedAt,
  createdAt: productAlerts.createdAt,
  productId: catalogProducts.id,
  productNameAr: catalogProducts.nameAr,
  productKind: catalogProducts.kind,
  gameId: catalogGames.id,
  gameSlug: catalogGames.slug,
  gameNameAr: catalogGames.nameAr,
  coverFileId: catalogGames.coverFileId,
  coverWidth: storedFiles.width,
  coverHeight: storedFiles.height,
};

type AlertRow = Awaited<ReturnType<typeof alertsQuery>>[number];

function toProductAlert(row: AlertRow): ProductAlert {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    product: { id: row.productId, nameAr: row.productNameAr, kind: row.productKind },
    game: {
      id: row.gameId,
      slug: row.gameSlug,
      nameAr: row.gameNameAr,
      cover:
        row.coverFileId !== null && row.coverWidth !== null && row.coverHeight !== null
          ? {
              id: row.coverFileId,
              url: catalogImagePath(row.coverFileId),
              width: row.coverWidth,
              height: row.coverHeight,
            }
          : null,
    },
    baselinePriceUsdUnits: row.baselinePriceUsdUnits,
    expiresAt: row.expiresAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function alertsQuery(db: Executor) {
  return db
    .select(alertColumns)
    .from(productAlerts)
    .innerJoin(catalogProducts, eq(catalogProducts.id, productAlerts.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .leftJoin(storedFiles, eq(storedFiles.id, catalogGames.coverFileId));
}

/**
 * PA1 in the caller's transaction: the customer's alerts queue on one advisory lock, so the limit
 * of 30 holds under parallel requests. An active alert of the same kind is answered as it is
 * (`created: false`); otherwise the pack's state on the customer's list must fit the kind, and a
 * price drop keeps the unit price the customer sees as its baseline.
 */
export async function createProductAlert(
  tx: Transaction,
  context: RoutingContext,
  customerId: string,
  input: CreateProductAlert,
  now: Date,
): Promise<{ alert: ProductAlert; created: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-alerts:${customerId}`}))`);
  const [existing] = await alertsQuery(tx).where(
    and(
      eq(productAlerts.customerId, customerId),
      eq(productAlerts.productId, input.productId),
      eq(productAlerts.kind, input.kind),
      eq(productAlerts.status, 'active'),
    ),
  );
  if (existing) return { alert: toProductAlert(existing), created: false };

  const pricing = await accountPriceList(tx, customerId);
  if (!pricing) throw new Error(`Customer ${customerId} does not exist`);
  const pack = (await packsOnList(tx, [input.productId], pricing.effectiveList.id, context)).get(
    input.productId,
  );
  if (!pack) throw new ProductAlertError('NOT_FOUND', 'No such product');
  const reason = productAlertRefusal(input.kind, pack);
  if (reason !== null)
    throw new ProductAlertError('PRODUCT_ALERT_INVALID', 'The pack does not fit the alert', {
      reason,
    });
  const [active] = await tx
    .select({ total: count() })
    .from(productAlerts)
    .where(and(eq(productAlerts.customerId, customerId), eq(productAlerts.status, 'active')));
  if ((active?.total ?? 0) >= PRODUCT_ALERTS_MAX)
    throw new ProductAlertError('PRODUCT_ALERTS_LIMIT_REACHED', 'Too many active alerts', {
      limit: PRODUCT_ALERTS_MAX,
    });

  const [inserted] = await tx
    .insert(productAlerts)
    .values({
      customerId,
      productId: input.productId,
      kind: input.kind,
      baselinePriceUsdUnits: input.kind === 'price_drop' ? pack.unitPriceUsdUnits : null,
      priceListId: pricing.effectiveList.id,
      expiresAt: new Date(now.getTime() + PRODUCT_ALERT_DAYS * DAY_MS),
    })
    .returning({ id: productAlerts.id });
  if (!inserted) throw new Error('The alert was not written');
  const [row] = await alertsQuery(tx).where(eq(productAlerts.id, inserted.id));
  if (!row) throw new Error('The alert was not read back');
  return { alert: toProductAlert(row), created: true };
}

/** PA6: the customer cancels an alert; false for another customer's or an unknown alert. */
export async function cancelProductAlert(
  db: Executor,
  customerId: string,
  alertId: string,
): Promise<boolean> {
  const [own] = await db
    .select({ status: productAlerts.status })
    .from(productAlerts)
    .where(and(eq(productAlerts.id, alertId), eq(productAlerts.customerId, customerId)));
  if (!own) return false;
  await db
    .update(productAlerts)
    .set({ status: 'cancelled', endedAt: sql`now()` })
    .where(and(eq(productAlerts.id, alertId), eq(productAlerts.status, 'active')));
  return true;
}

/** PA7: the active alerts (a game's, or all), or the newest 20 ended ones. */
export async function customerProductAlerts(
  db: Executor,
  customerId: string,
  query: ProductAlertListQuery,
): Promise<ProductAlert[]> {
  const own = eq(productAlerts.customerId, customerId);
  const rows =
    query.status === 'active'
      ? await alertsQuery(db)
          .where(
            and(
              own,
              eq(productAlerts.status, 'active'),
              query.gameId ? eq(catalogGames.id, query.gameId) : undefined,
            ),
          )
          .orderBy(desc(productAlerts.createdAt), desc(productAlerts.id))
      : await alertsQuery(db)
          .where(
            and(
              own,
              ne(productAlerts.status, 'active'),
              query.gameId ? eq(catalogGames.id, query.gameId) : undefined,
            ),
          )
          .orderBy(desc(productAlerts.endedAt), desc(productAlerts.id))
          .limit(PRODUCT_ALERTS_ENDED_SHOWN);
  return rows.map(toProductAlert);
}

/** PA8: active availability alerts per product ("بانتظار التوفر: N"). */
export async function waitingAlertCounts(
  db: Executor,
  productIds: readonly string[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({ productId: productAlerts.productId, total: count() })
    .from(productAlerts)
    .where(
      and(
        inArray(productAlerts.productId, [...new Set(productIds)]),
        eq(productAlerts.status, 'active'),
        eq(productAlerts.kind, 'available'),
      ),
    )
    .groupBy(productAlerts.productId);
  return new Map(rows.map((row) => [row.productId, row.total]));
}

/** The admin profile's count of a customer's active alerts. */
export async function activeAlertCount(db: Executor, customerId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(productAlerts)
    .where(and(eq(productAlerts.customerId, customerId), eq(productAlerts.status, 'active')));
  return row?.total ?? 0;
}

export interface ProductAlertRun {
  sent: number;
  rebased: number;
  expired: number;
  cancelled: number;
}

/**
 * PA3–PA6, the job's run: active alerts in id order, 500 a batch. A batch's packs are read once
 * per effective list, then each alert is settled in its own short transaction, locked
 * `FOR UPDATE SKIP LOCKED` and still active: an archived customer or pack cancels it, a passed
 * expiry ends it, a list change rebases it, a due alert is marked sent with its notification
 * (center and push). Running twice sends nothing new.
 */
export async function runProductAlerts(
  db: Executor,
  context: RoutingContext & { jobs: JobSender },
  now: Date,
): Promise<ProductAlertRun> {
  const run: ProductAlertRun = { sent: 0, rebased: 0, expired: 0, cancelled: 0 };
  let after: string | null = null;
  for (;;) {
    const batch = await db
      .select({
        id: productAlerts.id,
        customerId: productAlerts.customerId,
        productId: productAlerts.productId,
      })
      .from(productAlerts)
      .where(
        and(eq(productAlerts.status, 'active'), after ? gt(productAlerts.id, after) : undefined),
      )
      .orderBy(asc(productAlerts.id))
      .limit(PRODUCT_ALERTS_BATCH);
    if (batch.length === 0) return run;
    after = batch[batch.length - 1]?.id ?? null;

    const lists = new Map<string, string>();
    for (const customerId of new Set(batch.map((alert) => alert.customerId))) {
      const pricing = await accountPriceList(db, customerId);
      if (pricing) lists.set(customerId, pricing.effectiveList.id);
    }
    const packs = new Map<string, Map<string, PackOnList>>();
    for (const listId of new Set(lists.values())) {
      const productIds = batch
        .filter((alert) => lists.get(alert.customerId) === listId)
        .map((alert) => alert.productId);
      packs.set(listId, await packsOnList(db, productIds, listId, context));
    }

    for (const alert of batch) {
      const listId = lists.get(alert.customerId);
      const pack = listId ? packs.get(listId)?.get(alert.productId) : undefined;
      const outcome = await db.transaction((tx) =>
        settleProductAlert(
          tx,
          context.jobs,
          alert.id,
          listId && pack ? { listId, pack } : null,
          now,
        ),
      );
      if (outcome) run[outcome] += 1;
    }
    if (batch.length < PRODUCT_ALERTS_BATCH) return run;
  }
}

async function settleProductAlert(
  tx: Transaction,
  jobs: JobSender,
  alertId: string,
  current: { listId: string; pack: PackOnList } | null,
  now: Date,
): Promise<keyof ProductAlertRun | null> {
  const [alert] = await tx
    .select({
      id: productAlerts.id,
      customerId: productAlerts.customerId,
      kind: productAlerts.kind,
      baselinePriceUsdUnits: productAlerts.baselinePriceUsdUnits,
      priceListId: productAlerts.priceListId,
      expiresAt: productAlerts.expiresAt,
      productId: catalogProducts.id,
      productNameAr: catalogProducts.nameAr,
      productArchivedAt: catalogProducts.archivedAt,
      gameSlug: catalogGames.slug,
      gameNameAr: catalogGames.nameAr,
      customerArchivedAt: customers.archivedAt,
    })
    .from(productAlerts)
    .innerJoin(catalogProducts, eq(catalogProducts.id, productAlerts.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .innerJoin(customers, eq(customers.id, productAlerts.customerId))
    .where(and(eq(productAlerts.id, alertId), eq(productAlerts.status, 'active')))
    .for('update', { of: productAlerts, skipLocked: true });
  if (!alert) return null;
  const end = (status: 'expired' | 'cancelled') =>
    tx.update(productAlerts).set({ status, endedAt: now }).where(eq(productAlerts.id, alert.id));

  if (alert.customerArchivedAt !== null || alert.productArchivedAt !== null) {
    await end('cancelled');
    return 'cancelled';
  }
  if (alert.expiresAt.getTime() <= now.getTime()) {
    await end('expired');
    return 'expired';
  }
  if (current === null) return null;

  const outcome = alertDue(alert, {
    priceListId: current.listId,
    available: current.pack.available && !current.pack.hidden,
    unitPriceUsdUnits: current.pack.unitPriceUsdUnits,
  });
  if (outcome === null) return null;
  if (outcome === 'rebase') {
    // PA5: the new list's current price; a pack without one there keeps the old baseline.
    await tx
      .update(productAlerts)
      .set({
        priceListId: current.listId,
        baselinePriceUsdUnits:
          alert.kind === 'price_drop'
            ? (current.pack.unitPriceUsdUnits ?? alert.baselinePriceUsdUnits)
            : null,
      })
      .where(eq(productAlerts.id, alert.id));
    return 'rebased';
  }

  await tx
    .update(productAlerts)
    .set({ status: 'sent', sentAt: now, endedAt: now })
    .where(eq(productAlerts.id, alert.id));
  const pack = {
    alertId: alert.id,
    productId: alert.productId,
    productNameAr: alert.productNameAr,
    gameSlug: alert.gameSlug,
    gameNameAr: alert.gameNameAr,
  };
  if (outcome === 'available')
    await notifyCustomer(tx, jobs, {
      customerId: alert.customerId,
      event: 'product_available',
      params: pack,
    });
  else
    await notifyCustomer(tx, jobs, {
      customerId: alert.customerId,
      event: 'product_price_dropped',
      params: {
        ...pack,
        oldUnitPriceUsdUnits: alert.baselinePriceUsdUnits as number,
        newUnitPriceUsdUnits: current.pack.unitPriceUsdUnits as number,
      },
    });
  return 'sent';
}

/** The sweep: ended alerts are deleted 90 days after they ended. */
export async function deleteOldProductAlerts(db: Executor, now: Date): Promise<number> {
  const deleted = await db
    .delete(productAlerts)
    .where(
      and(
        ne(productAlerts.status, 'active'),
        isNotNull(productAlerts.endedAt),
        lt(productAlerts.endedAt, new Date(now.getTime() - PRODUCT_ALERT_RETENTION_DAYS * DAY_MS)),
      ),
    )
    .returning({ id: productAlerts.id });
  return deleted.length;
}
