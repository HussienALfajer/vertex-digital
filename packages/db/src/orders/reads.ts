import {
  ADMIN_ORDER_TAB_STATUSES,
  type AdminOrder,
  type AdminOrderCounts,
  type AdminOrderListQuery,
  type AdminOrderSummary,
  type CatalogImage,
  catalogImagePath,
  DELIVERY_STATS_SAMPLE_DAYS,
  DELIVERY_STATS_SAMPLE_SIZE,
  type DeliveryStats,
  deliveryStats,
  type FulfilmentAttempt,
  isOpenAttempt,
  maskCode,
  type Order,
  type OrderSummary,
  orderCustomerStage,
  orderDecisions,
  orderNumberSchema,
  type RouteCandidate,
  stageTimeline,
} from '@vertex-digital/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  catalogGames,
  catalogInputFields,
  catalogProducts,
  customers,
  fulfilmentAttempts,
  ledgerJournals,
  ledgerPostings,
  orderCodeReveals,
  orderCodes,
  orderEvents,
  orders,
  storedFiles,
  supplierOffers,
  suppliers,
  supplierWebhookEvents,
} from '../schema/index.js';
import { decryptSecret } from './secrets.js';
import type { OrderRow } from './transition.js';

/*
 * What the customer and the admin read of orders (S08 "API"), shaped as the contracts' schemas.
 * Customer reads always filter by the customer: another customer's order is not found. Codes are
 * decrypted only by `revealCode`, which logs the reveal in the caller's transaction (rules C2, C3).
 */

type Executor = Database | Transaction;

const iso = (date: Date | null) => date?.toISOString() ?? null;

async function covers(
  db: Executor,
  fileIds: (string | null)[],
): Promise<Map<string, CatalogImage>> {
  const ids = [...new Set(fileIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: storedFiles.id, width: storedFiles.width, height: storedFiles.height })
    .from(storedFiles)
    .where(inArray(storedFiles.id, ids));
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, url: catalogImagePath(row.id), width: row.width, height: row.height },
    ]),
  );
}

/** The order's field values with their labels, in the game's field order (archived kept). */
async function fieldsWithLabels(db: Executor, order: OrderRow) {
  const rules = await db
    .select({ key: catalogInputFields.key, labelAr: catalogInputFields.labelAr })
    .from(catalogInputFields)
    .where(eq(catalogInputFields.gameId, order.gameId))
    .orderBy(asc(catalogInputFields.sortOrder));
  const labels = new Map(rules.map((rule) => [rule.key, rule.labelAr]));
  const order_ = [...labels.keys()];
  return Object.entries(order.fields)
    .sort(([a], [b]) => order_.indexOf(a) - order_.indexOf(b))
    .map(([key, value]) => ({ key, labelAr: labels.get(key) ?? key, value }));
}

// Customer ----------------------------------------------------------------------------------------

/** One page of the customer's orders, newest first (`GET /api/orders`). */
export async function customerOrderPage(
  db: Executor,
  customerId: string,
  page: { after: { at: string; id: string } | null; limit: number },
): Promise<{ items: OrderSummary[]; more: boolean; last: { at: string; id: string } | null }> {
  const rows = await db
    .select({
      order: orders,
      /** The database's own text, microseconds kept (the API's cursor). */
      at: sql<string>`${orders.createdAt}::text`,
      productNameAr: catalogProducts.nameAr,
      game: {
        id: catalogGames.id,
        slug: catalogGames.slug,
        nameAr: catalogGames.nameAr,
        coverFileId: catalogGames.coverFileId,
      },
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(
      and(
        eq(orders.customerId, customerId),
        page.after
          ? or(
              sql`${orders.createdAt} < ${page.after.at}::timestamptz`,
              and(
                sql`${orders.createdAt} = ${page.after.at}::timestamptz`,
                lt(orders.id, page.after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(page.limit + 1);
  const shown = rows.slice(0, page.limit);
  const images = await covers(
    db,
    shown.map((row) => row.game.coverFileId),
  );
  const lastRow = shown.at(-1);
  return {
    items: shown.map(({ order, productNameAr, game }) => ({
      id: order.id,
      number: order.number,
      stage: orderCustomerStage(order.status),
      productNameAr,
      game: {
        id: game.id,
        slug: game.slug,
        nameAr: game.nameAr,
        cover: (game.coverFileId && images.get(game.coverFileId)) || null,
      },
      quantity: order.quantity,
      totalUsdUnits: order.totalUsdUnits,
      totalSypUnits: order.totalSypUnits,
      createdAt: order.createdAt.toISOString(),
    })),
    more: rows.length > page.limit,
    last: lastRow ? { at: lastRow.at, id: lastRow.order.id } : null,
  };
}

/** The customer's order (`GET /api/orders/:id`), or null when it is not theirs. */
export async function customerOrder(
  db: Executor,
  customerId: string,
  orderId: string,
): Promise<Order | null> {
  const [row] = await db
    .select({ order: orders, product: catalogProducts, game: catalogGames })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  if (!row) return null;
  const { order, product, game } = row;
  const [fields, statusEvents, codes, images] = await Promise.all([
    fieldsWithLabels(db, order),
    db
      .select({ status: orderEvents.toStatus, at: orderEvents.createdAt })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'status')))
      .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
    orderCodeList(db, order.id),
    covers(db, [game.coverFileId]),
  ]);
  return {
    id: order.id,
    number: order.number,
    stage: orderCustomerStage(order.status),
    product: {
      id: product.id,
      nameAr: product.nameAr,
      kind: product.kind,
      regionAr: product.regionAr,
      redemptionAr: product.redemptionAr,
    },
    game: {
      id: game.id,
      slug: game.slug,
      nameAr: game.nameAr,
      cover: (game.coverFileId && images.get(game.coverFileId)) || null,
    },
    fields,
    quantity: order.quantity,
    deliveredQuantity: order.deliveredQuantity,
    refundedQuantity: order.refundedQuantity,
    unitPriceUsdUnits: order.unitPriceUsdUnits,
    totalUsdUnits: order.totalUsdUnits,
    totalSypUnits: order.totalSypUnits,
    refundedUsdUnits: order.refundedUsdUnits,
    refundReason: order.refundReason,
    timeline: stageTimeline(
      statusEvents.flatMap((event) =>
        event.status ? [{ status: event.status, at: event.at }] : [],
      ),
    ).map((entry) => ({ stage: entry.stage, at: entry.at.toISOString() })),
    codes: codes.map((code) => ({
      id: code.id,
      position: code.index,
      masked: maskCode(code.hint),
      firstRevealedAt: iso(code.firstCustomerReveal),
    })),
    createdAt: order.createdAt.toISOString(),
  };
}

/** The order's codes in delivery order, numbered from 1, with the customer's first reveal. */
async function orderCodeList(db: Executor, orderId: string) {
  const rows = await db
    .select({
      id: orderCodes.id,
      attemptId: orderCodes.attemptId,
      hint: orderCodes.hint,
      firstCustomerReveal:
        sql<Date | null>`(select min(${orderCodeReveals.createdAt}) from ${orderCodeReveals}
        where ${orderCodeReveals.codeId} = ${orderCodes.id} and ${orderCodeReveals.actor} = 'customer')`.mapWith(
          (value: string | null) => (value === null ? null : new Date(value)),
        ),
    })
    .from(orderCodes)
    .innerJoin(fulfilmentAttempts, eq(fulfilmentAttempts.id, orderCodes.attemptId))
    .where(eq(orderCodes.orderId, orderId))
    .orderBy(asc(fulfilmentAttempts.createdAt), asc(orderCodes.position));
  return rows.map((row, index) => ({ ...row, index: index + 1 }));
}

export interface RevealInput {
  orderId: string;
  codeId: string;
  /** Set for a customer: the order must be theirs. */
  customerId: string | null;
  actor: 'customer' | 'admin';
  actorId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Rules C2, C3: decrypts one code of the order and logs the reveal in the caller's transaction.
 * Null when the code is not the order's, or the order not the customer's. `firstRevealedAt` is
 * the customer's first reveal (this one, the first time).
 */
export async function revealCode(
  tx: Transaction,
  codesKey: Buffer,
  input: RevealInput,
): Promise<{ code: string; position: number; firstRevealedAt: Date } | null> {
  const [row] = await tx
    .select({ code: orderCodes, customerId: orders.customerId })
    .from(orderCodes)
    .innerJoin(orders, eq(orders.id, orderCodes.orderId))
    .where(and(eq(orderCodes.id, input.codeId), eq(orderCodes.orderId, input.orderId)));
  if (!row || (input.customerId !== null && row.customerId !== input.customerId)) return null;
  const code = decryptSecret(codesKey, row.code.id, row.code.ciphertext);
  const [reveal] = await tx
    .insert(orderCodeReveals)
    .values({
      id: newId(),
      codeId: row.code.id,
      orderId: input.orderId,
      actor: input.actor,
      actorId: input.actorId,
      ip: input.ipAddress,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    })
    .returning({ createdAt: orderCodeReveals.createdAt });
  const [first] = await tx
    .select({ at: sql<string>`min(${orderCodeReveals.createdAt})` })
    .from(orderCodeReveals)
    .where(and(eq(orderCodeReveals.codeId, row.code.id), eq(orderCodeReveals.actor, 'customer')));
  return {
    code,
    position: row.code.position,
    firstRevealedAt: first?.at ? new Date(first.at) : (reveal?.createdAt as Date),
  };
}

// Admin -------------------------------------------------------------------------------------------

const OPEN = sql`(${fulfilmentAttempts.status} in ('sending', 'pending', 'unknown'))`;

/** Orders with an open attempt at the manual supplier (rule MN1). */
const manualWaiting = sql`exists (select 1 from ${fulfilmentAttempts}
  join ${suppliers} on ${suppliers.id} = ${fulfilmentAttempts.supplierId}
  where ${fulfilmentAttempts.orderId} = ${orders.id} and ${OPEN} and ${suppliers.code} = 'manual')`;

function adminFilters(query: AdminOrderListQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (query.tab === 'manual') conditions.push(manualWaiting);
  else if (query.tab !== 'all') {
    conditions.push(inArray(orders.status, [...ADMIN_ORDER_TAB_STATUSES[query.tab]]));
  }
  if (query.status) conditions.push(eq(orders.status, query.status));
  if (query.q) {
    const number = orderNumberSchema.safeParse(query.q);
    conditions.push(
      number.success
        ? eq(orders.number, number.data)
        : ilike(customers.email, `%${query.q.replace(/[\\%_]/g, '\\$&')}%`),
    );
  }
  if (query.productId) conditions.push(eq(orders.productId, query.productId));
  if (query.supplier) {
    conditions.push(sql`exists (select 1 from ${fulfilmentAttempts}
      join ${suppliers} on ${suppliers.id} = ${fulfilmentAttempts.supplierId}
      where ${fulfilmentAttempts.orderId} = ${orders.id} and ${suppliers.code} = ${query.supplier})`);
  }
  if (query.test) conditions.push(eq(orders.isTest, query.test === 'true'));
  if (query.from) conditions.push(gte(orders.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(orders.createdAt, new Date(query.to)));
  return and(...conditions);
}

/** `GET /api/admin/orders`: newest first, one page and the total. */
export async function adminOrderPage(
  db: Executor,
  query: AdminOrderListQuery,
): Promise<{ items: AdminOrderSummary[]; total: number }> {
  const where = adminFilters(query);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        order: orders,
        customer: { id: customers.id, name: customers.name, email: customers.email },
        product: { id: catalogProducts.id, nameAr: catalogProducts.nameAr },
        game: { id: catalogGames.id, nameAr: catalogGames.nameAr },
      })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
      .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ total: count() })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(where),
  ]);
  const ids = rows.map((row) => row.order.id);
  const latest =
    ids.length === 0
      ? []
      : await db
          .selectDistinctOn([fulfilmentAttempts.orderId], {
            orderId: fulfilmentAttempts.orderId,
            status: fulfilmentAttempts.status,
            supplierCode: suppliers.code,
          })
          .from(fulfilmentAttempts)
          .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
          .where(inArray(fulfilmentAttempts.orderId, ids))
          .orderBy(fulfilmentAttempts.orderId, desc(OPEN), desc(fulfilmentAttempts.createdAt));
  const attemptOf = new Map(latest.map((row) => [row.orderId, row]));
  return {
    items: rows.map(({ order, customer, product, game }) => {
      const attempt = attemptOf.get(order.id);
      return {
        id: order.id,
        number: order.number,
        status: order.status,
        customer: { ...customer, isTest: order.isTest },
        product,
        game,
        quantity: order.quantity,
        totalUsdUnits: order.totalUsdUnits,
        supplierCode: attempt?.supplierCode ?? null,
        manualWaiting:
          attempt !== undefined &&
          attempt.supplierCode === 'manual' &&
          isOpenAttempt(attempt.status),
        since: order.updatedAt.toISOString(),
        createdAt: order.createdAt.toISOString(),
      };
    }),
    total: totalRow?.total ?? 0,
  };
}

/** `GET /api/admin/orders/counts`: the navigation badge. */
export async function adminOrderCounts(db: Executor): Promise<AdminOrderCounts> {
  const [row] = await db
    .select({
      needsReview: sql<number>`count(*) filter (where ${orders.status} = 'needs_review')`.mapWith(
        Number,
      ),
      manualWaiting: sql<number>`count(*) filter (where ${manualWaiting})`.mapWith(Number),
    })
    .from(orders)
    .where(sql`${orders.finishedAt} is null`);
  return { needsReview: row?.needsReview ?? 0, manualWaiting: row?.manualWaiting ?? 0 };
}

/** The order's open attempt with its supplier, for the admin's decisions (rule D1). */
export async function openAttempt(db: Executor, orderId: string) {
  const [row] = await db
    .select({ attempt: fulfilmentAttempts, supplierCode: suppliers.code })
    .from(fulfilmentAttempts)
    .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
    .where(and(eq(fulfilmentAttempts.orderId, orderId), OPEN));
  return row ?? null;
}

/** `GET /api/admin/orders/:id`, or null. Codes masked; never their values. */
export async function adminOrder(db: Executor, orderId: string): Promise<AdminOrder | null> {
  const [row] = await db
    .select({
      order: orders,
      customer: { id: customers.id, name: customers.name, email: customers.email },
      product: {
        id: catalogProducts.id,
        nameAr: catalogProducts.nameAr,
        kind: catalogProducts.kind,
      },
      game: { id: catalogGames.id, nameAr: catalogGames.nameAr },
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(eq(orders.id, orderId));
  if (!row) return null;
  const { order } = row;
  const [fields, attempts, events, codes, webhooks] = await Promise.all([
    fieldsWithLabels(db, order),
    db
      .select({
        attempt: fulfilmentAttempts,
        supplierCode: suppliers.code,
        supplierNameAr: suppliers.nameAr,
        offerName: supplierOffers.name,
      })
      .from(fulfilmentAttempts)
      .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
      .innerJoin(supplierOffers, eq(supplierOffers.id, fulfilmentAttempts.offerId))
      .where(eq(fulfilmentAttempts.orderId, order.id))
      .orderBy(desc(fulfilmentAttempts.createdAt), desc(fulfilmentAttempts.id)),
    db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
    orderCodeList(db, order.id),
    db
      .select()
      .from(supplierWebhookEvents)
      .innerJoin(fulfilmentAttempts, eq(fulfilmentAttempts.id, supplierWebhookEvents.attemptId))
      .where(eq(fulfilmentAttempts.orderId, order.id))
      .orderBy(asc(supplierWebhookEvents.createdAt)),
  ]);
  const journalIds = [
    order.purchaseJournalId,
    ...(order.refundJournalId ? [order.refundJournalId] : []),
    ...attempts.flatMap(({ attempt }) => (attempt.costJournalId ? [attempt.costJournalId] : [])),
  ];
  const [journals, reveals] = await Promise.all([
    db
      .select({
        id: ledgerJournals.id,
        kind: ledgerJournals.kind,
        createdAt: ledgerJournals.createdAt,
        amount: sql<string>`sum(${ledgerPostings.amountUnits}) filter (where ${ledgerPostings.amountUnits} > 0)`,
      })
      .from(ledgerJournals)
      .innerJoin(ledgerPostings, eq(ledgerPostings.journalId, ledgerJournals.id))
      .where(inArray(ledgerJournals.id, journalIds))
      .groupBy(ledgerJournals.id)
      .orderBy(asc(ledgerJournals.createdAt)),
    codes.length === 0
      ? []
      : db
          .select()
          .from(orderCodeReveals)
          .where(
            inArray(
              orderCodeReveals.codeId,
              codes.map((code) => code.id),
            ),
          )
          .orderBy(asc(orderCodeReveals.createdAt)),
  ]);
  const open = attempts.find(({ attempt }) => isOpenAttempt(attempt.status));
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    customer: { ...row.customer, isTest: order.isTest },
    product: row.product,
    game: row.game,
    fields,
    quantity: order.quantity,
    deliveredQuantity: order.deliveredQuantity,
    refundedQuantity: order.refundedQuantity,
    unitPriceUsdUnits: order.unitPriceUsdUnits,
    totalUsdUnits: order.totalUsdUnits,
    totalSypUnits: order.totalSypUnits,
    minMarginUsdUnits: order.minMarginUsdUnits,
    refundedUsdUnits: order.refundedUsdUnits,
    refundReason: order.refundReason,
    paidAt: iso(order.paidAt),
    deliveredAt: iso(order.deliveredAt),
    finishedAt: iso(order.finishedAt),
    reviewSince: iso(order.reviewSince),
    createdAt: order.createdAt.toISOString(),
    decisions: orderDecisions(
      order.status,
      open ? { id: open.attempt.id, supplierCode: open.supplierCode } : null,
    ),
    attempts: attempts.map(
      ({ attempt, supplierCode, supplierNameAr, offerName }): FulfilmentAttempt => ({
        id: attempt.id,
        routeId: attempt.routeId,
        supplierCode,
        supplierNameAr,
        offerId: attempt.supplierOfferId,
        offerName,
        quantity: attempt.quantity,
        deliveredQuantity: attempt.deliveredQuantity,
        unitCostUsdUnits: attempt.unitCostUsdUnits,
        status: attempt.status,
        supplierOrderId: attempt.supplierOrderId,
        failureReason: attempt.failureReason,
        inputRejected: attempt.inputRejected,
        supplierErrorCode: attempt.supplierErrorCode,
        candidates: attempt.candidates as RouteCandidate[],
        resolvedBy: attempt.resolvedBy,
        adminReason: attempt.adminReason,
        pollCount: attempt.pollCount,
        sentAt: iso(attempt.sentAt),
        nextPollAt: iso(attempt.nextPollAt),
        resolvedAt: iso(attempt.resolvedAt),
        createdAt: attempt.createdAt.toISOString(),
        webhookEvents: webhooks
          .filter((hook) => hook.fulfilment_attempts.id === attempt.id)
          .map(({ supplier_webhook_events: hook }) => ({
            id: hook.id,
            eventId: hook.eventId,
            result: hook.result,
            processedAt: iso(hook.processedAt),
            createdAt: hook.createdAt.toISOString(),
          })),
      }),
    ),
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actor: event.actor,
      attemptId: event.attemptId,
      reason: event.reason,
      details: event.details,
      createdAt: event.createdAt.toISOString(),
    })),
    journals: journals.map((journal) => ({
      id: journal.id,
      kind: journal.kind as 'purchase' | 'refund' | 'cost_of_goods',
      amountUsdUnits: Number(journal.amount ?? 0),
      createdAt: journal.createdAt.toISOString(),
    })),
    codes: codes.map((code) => ({
      id: code.id,
      attemptId: code.attemptId,
      position: code.index,
      masked: maskCode(code.hint),
      reveals: reveals
        .filter((reveal) => reveal.codeId === code.id)
        .map((reveal) => ({
          actor: reveal.actor,
          ipAddress: reveal.ip,
          userAgent: reveal.userAgent,
          createdAt: reveal.createdAt.toISOString(),
        })),
    })),
  };
}

/**
 * Rule T1 per product: the durations of its last 50 delivered orders of non-test customers
 * within 30 days, as median and p90; null under 5.
 */
export async function productDeliveryStats(
  db: Executor,
  productIds: readonly string[],
): Promise<Map<string, DeliveryStats | null>> {
  const stats = new Map<string, DeliveryStats | null>(productIds.map((id) => [id, null]));
  if (productIds.length === 0) return stats;
  const sample = db
    .select({
      productId: orders.productId,
      ms: sql<string>`extract(epoch from ${orders.deliveredAt} - ${orders.paidAt}) * 1000`.as('ms'),
      rank: sql<number>`row_number() over (partition by ${orders.productId} order by ${orders.deliveredAt} desc)`.as(
        'rank',
      ),
    })
    .from(orders)
    .where(
      and(
        inArray(orders.productId, [...productIds]),
        eq(orders.status, 'delivered'),
        eq(orders.isTest, false),
        gte(orders.deliveredAt, sql`now() - make_interval(days => ${DELIVERY_STATS_SAMPLE_DAYS})`),
      ),
    )
    .as('sample');
  const rows = await db
    .select({ productId: sample.productId, ms: sample.ms })
    .from(sample)
    .where(lte(sample.rank, DELIVERY_STATS_SAMPLE_SIZE));
  const durations = new Map<string, number[]>();
  for (const row of rows) {
    durations.set(row.productId, [
      ...(durations.get(row.productId) ?? []),
      Math.round(Number(row.ms)),
    ]);
  }
  for (const [productId, list] of durations) stats.set(productId, deliveryStats(list));
  return stats;
}
