import {
  ADMIN_ORDER_TAB_STATUSES,
  type AdminOrder,
  type AdminOrderCounts,
  type AdminOrderListQuery,
  type AdminOrderSummary,
  type CatalogImage,
  type CheckoutInfo,
  catalogImagePath,
  DELIVERY_STATS_SAMPLE_DAYS,
  DELIVERY_STATS_SAMPLE_SIZE,
  type DeliveryStats,
  deliveryStats,
  type FulfilmentAttempt,
  isOpenAttempt,
  maskCode,
  maskFieldValue,
  type Order,
  type OrderStatus,
  type OrderSummary,
  orderCustomerStage,
  orderDecisions,
  orderFieldValuesSchema,
  orderNumberSchema,
  orderTimeline,
  type PublicShare,
  type RouteCandidate,
  type SavedPlayer,
  type ShareLink,
  shareStage,
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
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  checkouts,
  customers,
  fulfilmentAttempts,
  ledgerJournals,
  ledgerPostings,
  orderCodeReveals,
  orderCodes,
  orderEvents,
  orderShareLinks,
  orders,
  savedPlayers,
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

/** S09 rule SF1 for the order's pack: an unarchived product of a shown game. */
const packShown = sql<boolean>`(${catalogProducts.archivedAt} is null
  and ${catalogGames.status} = 'active' and ${catalogGames.archivedAt} is null
  and ${catalogCategories.archivedAt} is null)`;

/** S10 rule OT3: a delivered (or partly delivered) order of a pack still shown. */
function repeatable(status: OrderStatus, shown: boolean): boolean {
  return shown && (status === 'delivered' || status === 'partially_refunded');
}

/** The path of a share link on the store (rules GF5, RC2). */
export function sharePath(kind: 'gift' | 'receipt', token: string): string {
  return `/${kind === 'gift' ? 'g' : 'r'}/${token}`;
}

const giftOf = (order: OrderRow) =>
  order.isGift ? { senderName: order.giftSenderName, message: order.giftMessage } : null;

const summaryColumns = {
  order: orders,
  /** The database's own text, microseconds kept (the API's cursor). */
  at: sql<string>`${orders.createdAt}::text`,
  productNameAr: catalogProducts.nameAr,
  shown: packShown,
  game: {
    id: catalogGames.id,
    slug: catalogGames.slug,
    nameAr: catalogGames.nameAr,
    coverFileId: catalogGames.coverFileId,
  },
};

/** The customer's orders as "طلباتي" cards. */
async function summaries(
  db: Executor,
  rows: {
    order: OrderRow;
    productNameAr: string;
    shown: boolean;
    game: { id: string; slug: string; nameAr: string; coverFileId: string | null };
  }[],
): Promise<OrderSummary[]> {
  const images = await covers(
    db,
    rows.map((row) => row.game.coverFileId),
  );
  return rows.map(({ order, productNameAr, shown, game }) => ({
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
    expiresAt: iso(order.expiresAt),
    checkoutId: order.checkoutId,
    isGift: order.isGift,
    repeatable: repeatable(order.status, shown),
    createdAt: order.createdAt.toISOString(),
  }));
}

const summaryFrom = (db: Executor) =>
  db
    .select(summaryColumns)
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId));

/** One page of the customer's orders, newest first (`GET /api/orders`). */
export async function customerOrderPage(
  db: Executor,
  customerId: string,
  page: { after: { at: string; id: string } | null; limit: number },
): Promise<{ items: OrderSummary[]; more: boolean; last: { at: string; id: string } | null }> {
  const rows = await summaryFrom(db)
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
  const lastRow = shown.at(-1);
  return {
    items: await summaries(db, shown),
    more: rows.length > page.limit,
    last: lastRow ? { at: lastRow.at, id: lastRow.order.id } : null,
  };
}

/**
 * S10 rule CT6: the customer's checkout and its orders in line order (`GET /api/orders?checkout=`),
 * or null when the checkout is not theirs.
 */
export async function customerCheckout(
  db: Executor,
  customerId: string,
  checkoutId: string,
): Promise<{ checkout: CheckoutInfo; items: OrderSummary[] } | null> {
  const [checkout] = await db
    .select()
    .from(checkouts)
    .where(and(eq(checkouts.id, checkoutId), eq(checkouts.customerId, customerId)));
  if (!checkout) return null;
  const rows = await summaryFrom(db)
    .where(eq(orders.checkoutId, checkoutId))
    .orderBy(asc(orders.checkoutLine));
  return {
    checkout: {
      id: checkout.id,
      totalUsdUnits: checkout.totalUsdUnits,
      orderCount: checkout.lineCount,
      finishedAt: iso(checkout.finishedAt),
    },
    items: await summaries(db, rows),
  };
}

/** The order's live share links as its owner sees them (S10 rules GF4, RC1). */
async function liveShareLinks(db: Executor, orderId: string, storeUrl: string) {
  const rows = await db
    .select()
    .from(orderShareLinks)
    .where(and(eq(orderShareLinks.orderId, orderId), isNull(orderShareLinks.revokedAt)))
    .orderBy(asc(orderShareLinks.createdAt));
  return rows.map(
    (link): ShareLink => ({
      id: link.id,
      kind: link.kind,
      url: `${storeUrl}${sharePath(link.kind, link.token)}`,
      showPrice: link.showPrice,
      playerDisplay: link.playerDisplay,
      createdAt: link.createdAt.toISOString(),
    }),
  );
}

/** The customer's order (`GET /api/orders/:id`), or null when it is not theirs. */
export async function customerOrder(
  db: Executor,
  customerId: string,
  orderId: string,
  /** The store's origin, for the share links' URLs. */
  storeUrl = '',
): Promise<Order | null> {
  const [row] = await db
    .select({ order: orders, product: catalogProducts, game: catalogGames, shown: packShown })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  if (!row) return null;
  const { order, product, game } = row;
  const [fields, statusEvents, codes, images, stats, shareLinks] = await Promise.all([
    fieldsWithLabels(db, order),
    db
      .select({ status: orderEvents.toStatus, at: orderEvents.createdAt })
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.kind, 'status')))
      .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id)),
    orderCodeList(db, order.id),
    covers(db, [game.coverFileId]),
    productDeliveryStats(db, [product.id]),
    liveShareLinks(db, order.id, storeUrl),
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
    timeline: orderTimeline(
      statusEvents.flatMap((event) =>
        event.status ? [{ status: event.status, at: event.at }] : [],
      ),
    ).map((entry) => ({ step: entry.step, at: entry.at.toISOString() })),
    codes: codes.map((code) => ({
      id: code.id,
      position: code.index,
      masked: maskCode(code.hint),
      firstRevealedAt: iso(code.firstCustomerReveal),
    })),
    expiresAt: iso(order.expiresAt),
    cancelReason: order.cancelReason,
    playerName: order.playerName,
    deliveryStats: stats.get(product.id) ?? null,
    checkoutId: order.checkoutId,
    isGift: order.isGift,
    gift: giftOf(order),
    shareLinks,
    repeatable: repeatable(order.status, row.shown),
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function adminFilters(query: AdminOrderListQuery): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  if (query.tab === 'manual') conditions.push(manualWaiting);
  else if (query.tab !== 'all') {
    conditions.push(inArray(orders.status, [...ADMIN_ORDER_TAB_STATUSES[query.tab]]));
  }
  if (query.status) conditions.push(eq(orders.status, query.status));
  if (query.q) {
    const number = orderNumberSchema.safeParse(query.q);
    const checkout = UUID.test(query.q);
    conditions.push(
      number.success
        ? eq(orders.number, number.data)
        : checkout
          ? eq(orders.checkoutId, query.q.toLowerCase())
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
        checkoutId: order.checkoutId,
        isGift: order.isGift,
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
  const [fields, attempts, events, codes, webhooks, checkout, shareLinks] = await Promise.all([
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
      // S11: an `admin_fulfil` attempt has no offer.
      .leftJoin(supplierOffers, eq(supplierOffers.id, fulfilmentAttempts.offerId))
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
    order.checkoutId ? adminCheckout(db, order.checkoutId) : null,
    db
      .select()
      .from(orderShareLinks)
      .where(eq(orderShareLinks.orderId, order.id))
      .orderBy(asc(orderShareLinks.createdAt)),
  ]);
  const journalIds = [
    ...(order.purchaseJournalId ? [order.purchaseJournalId] : []),
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
    reservedAt: iso(order.reservedAt),
    expiresAt: iso(order.expiresAt),
    cancelReason: order.cancelReason,
    playerCheck: order.playerCheck,
    playerName: order.playerName,
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
        kind: attempt.kind,
        routeId: attempt.routeId,
        supplierCode,
        supplierNameAr,
        offerId: attempt.supplierOfferId,
        offerName,
        quantity: attempt.quantity,
        deliveredQuantity: attempt.deliveredQuantity,
        unitCostUsdUnits: attempt.unitCostUsdUnits,
        chosenByAdmin: attempt.chosenByAdmin,
        proofFileId: attempt.proofFileId,
        deliveryReference: attempt.deliveryReference,
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
    checkout,
    gift: giftOf(order),
    shareLinks: shareLinks.map((link) => ({
      id: link.id,
      kind: link.kind,
      showPrice: link.showPrice,
      playerDisplay: link.playerDisplay,
      createdAt: link.createdAt.toISOString(),
      revokedAt: iso(link.revokedAt),
      revokedBy: link.revokedBy,
      revokeReason: link.revokeReason,
    })),
  };
}

/** S10 rule AD1: the checkout of an order, with its orders in line order. */
async function adminCheckout(db: Executor, checkoutId: string): Promise<AdminOrder['checkout']> {
  const [checkout] = await db.select().from(checkouts).where(eq(checkouts.id, checkoutId));
  if (!checkout) return null;
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      line: orders.checkoutLine,
      status: orders.status,
    })
    .from(orders)
    .where(eq(orders.checkoutId, checkoutId))
    .orderBy(asc(orders.checkoutLine));
  return {
    id: checkout.id,
    totalUsdUnits: checkout.totalUsdUnits,
    orderCount: checkout.lineCount,
    finishedAt: iso(checkout.finishedAt),
    orders: rows.map((row) => ({ ...row, line: row.line as number })),
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

// Saved player ids and share pages (S10) ---------------------------------------------------------

/**
 * Rules SP3, SP5, SP7: the customer's saved ids (all, or one game's), newest used first, with the
 * game, the labels of its unarchived fields, and whether the values still validate against them.
 */
export async function customerSavedPlayers(
  db: Executor,
  customerId: string,
  filter: { gameId?: string; id?: string } = {},
): Promise<SavedPlayer[]> {
  const rows = await db
    .select({
      saved: savedPlayers,
      game: {
        id: catalogGames.id,
        slug: catalogGames.slug,
        nameAr: catalogGames.nameAr,
        coverFileId: catalogGames.coverFileId,
      },
      shown: sql<boolean>`(${catalogGames.status} = 'active' and ${catalogGames.archivedAt} is null
        and ${catalogCategories.archivedAt} is null)`,
    })
    .from(savedPlayers)
    .innerJoin(catalogGames, eq(catalogGames.id, savedPlayers.gameId))
    .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
    .where(
      and(
        eq(savedPlayers.customerId, customerId),
        filter.gameId ? eq(savedPlayers.gameId, filter.gameId) : undefined,
        filter.id ? eq(savedPlayers.id, filter.id) : undefined,
      ),
    )
    .orderBy(
      sql`${savedPlayers.lastUsedAt} desc nulls last`,
      desc(savedPlayers.createdAt),
      desc(savedPlayers.id),
    );
  const gameIds = [...new Set(rows.map((row) => row.game.id))];
  const [images, fields] = await Promise.all([
    covers(
      db,
      rows.map((row) => row.game.coverFileId),
    ),
    gameIds.length === 0
      ? []
      : db
          .select()
          .from(catalogInputFields)
          .where(
            and(inArray(catalogInputFields.gameId, gameIds), isNull(catalogInputFields.archivedAt)),
          )
          .orderBy(asc(catalogInputFields.sortOrder)),
  ]);
  return rows.map(({ saved, game, shown }) => {
    const rules = fields.filter((field) => field.gameId === game.id);
    return {
      id: saved.id,
      gameId: game.id,
      gameSlug: game.slug,
      gameNameAr: game.nameAr,
      cover: (game.coverFileId && images.get(game.coverFileId)) || null,
      gameShown: shown,
      label: saved.label,
      fields: saved.fields,
      fieldLabels: Object.fromEntries(rules.map((rule) => [rule.key, rule.labelAr])),
      playerName: saved.playerName,
      rejected: saved.rejectedAt !== null,
      complete: orderFieldValuesSchema(rules).safeParse(saved.fields).success,
      lastUsedAt: iso(saved.lastUsedAt),
    };
  });
}

/**
 * Rules GF5, RC2, SH1, SH3, SH4: what a live share link shows, and the game's cover file for the
 * image; null for an unknown or revoked token, or an order no longer in a shared status. Never a
 * code, the customer, the in-game name or SYP.
 */
export async function publicShare(
  db: Executor,
  token: string,
): Promise<{ share: PublicShare; coverFileId: string | null } | null> {
  const [row] = await db
    .select({ link: orderShareLinks, order: orders, product: catalogProducts, game: catalogGames })
    .from(orderShareLinks)
    .innerJoin(orders, eq(orders.id, orderShareLinks.orderId))
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(and(eq(orderShareLinks.token, token), isNull(orderShareLinks.revokedAt)));
  if (!row) return null;
  const { link, order, product, game } = row;
  const stage = shareStage(order.status, order.deliveredQuantity, order.quantity);
  if (!stage || !order.paidAt) return null;
  const rules = await db
    .select()
    .from(catalogInputFields)
    .where(eq(catalogInputFields.gameId, order.gameId))
    .orderBy(asc(catalogInputFields.sortOrder));
  const full = link.kind === 'receipt' && link.playerDisplay === 'full';
  const keys = rules.map((rule) => rule.key);
  const [cover] = (await covers(db, [game.coverFileId])).values();
  return {
    coverFileId: game.coverFileId,
    share: {
      kind: link.kind,
      orderNumber: link.kind === 'receipt' ? order.number : null,
      game: {
        nameAr: game.nameAr,
        nameEn: game.nameEn,
        cover: cover ?? null,
        accentColor: game.accentColor,
      },
      product: { nameAr: product.nameAr, kind: product.kind, gameAmount: product.gameAmount },
      quantity: order.quantity,
      deliveredQuantity: stage.deliveredQuantity,
      stage: stage.stage,
      paidAt: order.paidAt.toISOString(),
      finishedAt: iso(order.finishedAt),
      price:
        link.kind === 'receipt' && link.showPrice
          ? { totalUsdUnits: order.totalUsdUnits, refundedUsdUnits: order.refundedUsdUnits }
          : null,
      fields: Object.entries(order.fields)
        .sort(([a], [b]) => keys.indexOf(a) - keys.indexOf(b))
        .map(([key, value]) => {
          const rule = rules.find((candidate) => candidate.key === key);
          const option =
            rule?.type === 'select' ? rule.options?.find((o) => o.value === value) : null;
          return {
            label: rule?.labelAr ?? key,
            value: option ? option.labelAr : full ? value : maskFieldValue(value),
          };
        }),
      gift:
        link.kind === 'gift'
          ? { senderName: order.giftSenderName, message: order.giftMessage }
          : null,
    },
  };
}
