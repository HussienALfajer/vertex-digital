import { eq, inArray } from 'drizzle-orm';
import { type Database, readAll, type Transaction } from '../client.js';
import { catalogProducts, customers, deposits, orders } from '../schema/index.js';

/*
 * What a support ticket shows of the order or deposit it is about (S12 TK1, TK12): read here so
 * the api `support` module checks the link's owner and shows its summary without reading the
 * order and deposit tables itself.
 */

type Executor = Database | Transaction;

export interface TicketOrderLink {
  id: string;
  customerId: string;
  /** S26: the shop customer who bought a shop order; null for every other order. */
  shopCustomerId: string | null;
  number: string;
  status: (typeof orders.$inferSelect)['status'];
  /** S22 OP2, OP3: what the order's problem buttons depend on. */
  productKind: (typeof catalogProducts.$inferSelect)['kind'];
  paidAt: Date | null;
  finishedAt: Date | null;
  productNameAr: string;
  quantity: number;
  totalUsdUnits: number;
  createdAt: Date;
}

export interface TicketDepositLink {
  id: string;
  customerId: string;
  referenceCode: string;
  method: (typeof deposits.$inferSelect)['method'];
  status: (typeof deposits.$inferSelect)['status'];
  declaredUsdUnits: number;
  createdAt: Date;
}

/** The order a ticket names, or null. */
export async function ticketOrderLink(
  db: Executor,
  orderId: string,
): Promise<TicketOrderLink | null> {
  const [row] = await db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      shopCustomerId: orders.shopCustomerId,
      number: orders.number,
      status: orders.status,
      productKind: catalogProducts.kind,
      paidAt: orders.paidAt,
      finishedAt: orders.finishedAt,
      productNameAr: catalogProducts.nameAr,
      quantity: orders.quantity,
      totalUsdUnits: orders.totalUsdUnits,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .where(eq(orders.id, orderId));
  // A walk-in order (S16 AP1) has no customer to open a ticket.
  if (!row || row.customerId === null) return null;
  return { ...row, customerId: row.customerId };
}

/**
 * The order a ticket of its buyer names: a Vertex customer's own order (never a shop order of a
 * merchant's, S26 PR9), or a shop customer's shop order (TK1); null otherwise.
 */
export async function ticketOrderOf(
  db: Executor,
  orderId: string,
  owner: { customerId: string } | { shopCustomerId: string },
): Promise<TicketOrderLink | null> {
  const order = await ticketOrderLink(db, orderId);
  if (!order) return null;
  const mine =
    'shopCustomerId' in owner
      ? order.shopCustomerId === owner.shopCustomerId
      : order.customerId === owner.customerId && order.shopCustomerId === null;
  return mine ? order : null;
}

/** The deposit a ticket names, or null. */
export async function ticketDepositLink(
  db: Executor,
  depositId: string,
): Promise<TicketDepositLink | null> {
  const [row] = await db
    .select({
      id: deposits.id,
      customerId: deposits.customerId,
      referenceCode: deposits.referenceCode,
      method: deposits.method,
      status: deposits.status,
      declaredUsdUnits: deposits.declaredUsdUnits,
      createdAt: deposits.createdAt,
    })
    .from(deposits)
    .where(eq(deposits.id, depositId));
  return row ?? null;
}

/**
 * The order numbers and deposit references a page of tickets names, in two reads for the whole
 * page rather than one per ticket (audit A07-21).
 */
export async function ticketLinkLabels(
  db: Executor,
  links: { orderIds: readonly string[]; depositIds: readonly string[] },
): Promise<{ orders: Map<string, string>; deposits: Map<string, string> }> {
  const [orderRows, depositRows] = await readAll(db, [
    () =>
      links.orderIds.length === 0
        ? []
        : db
            .select({ id: orders.id, label: orders.number })
            .from(orders)
            .where(inArray(orders.id, [...links.orderIds])),
    () =>
      links.depositIds.length === 0
        ? []
        : db
            .select({ id: deposits.id, label: deposits.referenceCode })
            .from(deposits)
            .where(inArray(deposits.id, [...links.depositIds])),
  ]);
  return {
    orders: new Map(orderRows.map((row) => [row.id, row.label])),
    deposits: new Map(depositRows.map((row) => [row.id, row.label])),
  };
}

/**
 * The ticket's customer `FOR SHARE`, taken in every ticket write before the ticket's own lock: an
 * archive locks the customer before closing the open tickets (S12 AR2), so a ticket write and an
 * archive never interleave (audit A07-19). Null when the customer does not exist.
 */
export async function lockTicketCustomer(
  tx: Transaction,
  customerId: string,
): Promise<{ id: string; archived: boolean } | null> {
  const [row] = await tx
    .select({ id: customers.id, archivedAt: customers.archivedAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .for('share');
  return row ? { id: row.id, archived: row.archivedAt !== null } : null;
}
