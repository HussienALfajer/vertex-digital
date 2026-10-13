import type { SupplierOrderMatch } from '@vertex-digital/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { fulfilmentAttempts, orders, suppliers } from '../schema/index.js';

/*
 * S16 SF3, SF4: the supplier's statement matched to our attempts by `supplier_order_id`, for the
 * `suppliers` module's live reads (it owns no order table).
 */

type Executor = Database | Transaction;

/**
 * Our attempts that name these supplier order ids, the newest per id. An id no attempt names is
 * missing from the map ("غير مطابق لطلب عندنا").
 */
export async function supplierOrderMatches(
  db: Executor,
  supplierId: string,
  supplierOrderIds: readonly string[],
): Promise<Map<string, SupplierOrderMatch>> {
  const matches = new Map<string, SupplierOrderMatch>();
  const ids = [...new Set(supplierOrderIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return matches;
  const rows = await db
    .select({
      supplierOrderId: fulfilmentAttempts.supplierOrderId,
      attemptId: fulfilmentAttempts.id,
      attemptStatus: fulfilmentAttempts.status,
      orderId: orders.id,
      orderNumber: orders.number,
      orderStatus: orders.status,
    })
    .from(fulfilmentAttempts)
    .innerJoin(orders, eq(orders.id, fulfilmentAttempts.orderId))
    .where(
      and(
        eq(fulfilmentAttempts.supplierId, supplierId),
        inArray(fulfilmentAttempts.supplierOrderId, ids),
      ),
    )
    .orderBy(desc(fulfilmentAttempts.createdAt), desc(fulfilmentAttempts.id));
  for (const row of rows) {
    const key = row.supplierOrderId as string;
    if (matches.has(key)) continue;
    matches.set(key, {
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      orderStatus: row.orderStatus,
      attemptId: row.attemptId,
      attemptStatus: row.attemptStatus,
    });
  }
  return matches;
}

/** What rule SF4 reads of an attempt: its supplier, offer, units and send time. */
export interface AttemptSupplierFacts {
  attemptId: string;
  supplierId: string;
  supplierCode: (typeof suppliers.$inferSelect)['code'];
  supplierOfferId: string | null;
  quantity: number;
  sentAt: Date | null;
}

/** The attempt of an order, or null when the order has no such attempt. */
export async function attemptSupplierFacts(
  db: Executor,
  orderId: string,
  attemptId: string,
): Promise<AttemptSupplierFacts | null> {
  const [row] = await db
    .select({
      attemptId: fulfilmentAttempts.id,
      supplierId: fulfilmentAttempts.supplierId,
      supplierCode: suppliers.code,
      supplierOfferId: fulfilmentAttempts.supplierOfferId,
      quantity: fulfilmentAttempts.quantity,
      sentAt: fulfilmentAttempts.sentAt,
    })
    .from(fulfilmentAttempts)
    .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
    .where(and(eq(fulfilmentAttempts.id, attemptId), eq(fulfilmentAttempts.orderId, orderId)));
  return row ?? null;
}
