import { eq } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { catalogProducts, deposits, orders } from '../schema/index.js';

/*
 * What a support ticket shows of the order or deposit it is about (S12 TK1, TK12): read here so
 * the api `support` module checks the link's owner and shows its summary without reading the
 * order and deposit tables itself.
 */

type Executor = Database | Transaction;

export interface TicketOrderLink {
  id: string;
  customerId: string;
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
