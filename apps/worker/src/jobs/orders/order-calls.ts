import type { SupplierCallResult } from '@vertex-digital/contracts';
import {
  type AttemptOutcome,
  type AttemptRow,
  bossJobSender,
  type Database,
  type OrderContext,
  orders,
  productRoutes,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import { outcomeOfOrderError, type SupplierOutcome } from '@vertex-digital/suppliers';
import { eq } from 'drizzle-orm';
import type { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { recordedCall, sanitizedMessage } from '../../suppliers/supplier-calls.js';
import type { SupplierRegistry } from '../../suppliers/supplier-registry.js';

/*
 * The supplier side of an attempt (S08 rules R3, F3): `placeOrder` with the attempt id as the
 * idempotency key, or `getOrder` for a pending one, each recorded in `supplier_calls`, the answer
 * classified for `applyOutcome`. Outcomes carry codes: never logged, never in an error.
 */

type Executor = Database | Transaction;

/** The order context of a job: jobs in the caller's transaction, the codes key, the time. */
export function orderContext(
  pgBoss: PgBossService,
  codesKey: Buffer,
  now = new Date(),
): OrderContext {
  return { jobs: bossJobSender(pgBoss.boss), codesKey, now };
}

/** How an order answer counts for health (S07 rule H1). */
const callResult = (outcome: SupplierOutcome): SupplierCallResult =>
  outcome.status === 'failed_definitive'
    ? 'refused'
    : outcome.status === 'unknown'
      ? 'error'
      : 'ok';

/** The adapter's answer as the write path takes it, reasons cleaned of credentials. */
export function attemptOutcome(
  outcome: SupplierOutcome,
  secrets: readonly string[],
): AttemptOutcome {
  const clean = (reason: string) => sanitizedMessage(reason, secrets).slice(0, 200);
  switch (outcome.status) {
    case 'delivered':
      return {
        status: 'delivered',
        quantity: outcome.quantity,
        ...(outcome.codes && { codes: outcome.codes }),
        supplierOrderId: outcome.supplierOrderId,
      };
    case 'pending':
      return { status: 'pending', supplierOrderId: outcome.supplierOrderId };
    case 'failed_definitive':
      return {
        status: 'failed',
        reason: clean(outcome.reason),
        inputRejected: outcome.inputRejected === true,
        supplierErrorCode: outcome.supplierCode ?? null,
        supplierOrderId: outcome.supplierOrderId ?? null,
      };
    default:
      return {
        status: 'unknown',
        reason: clean(outcome.reason),
        supplierOrderId: outcome.supplierOrderId ?? null,
      };
  }
}

/**
 * Asks the attempt's supplier: `place` sends the order (again, with the same key: rules R3, F3,
 * F6), `get` reads a pending one. A supplier with no adapter or credentials here now gives
 * `unknown` (rule F8: the attempt stays with it and is polled again).
 */
export async function askSupplier(
  db: Executor,
  registry: SupplierRegistry,
  attempt: AttemptRow,
  call: 'place' | 'get',
): Promise<AttemptOutcome> {
  const [row] = await db
    .select({
      code: suppliers.code,
      fieldMap: productRoutes.fieldMap,
      fields: orders.fields,
    })
    .from(suppliers)
    .innerJoin(productRoutes, eq(productRoutes.id, attempt.routeId))
    .innerJoin(orders, eq(orders.id, attempt.orderId))
    .where(eq(suppliers.id, attempt.supplierId));
  if (!row) throw new Error(`Attempt ${attempt.id} names no supplier, route or order`);
  let connected: Awaited<ReturnType<SupplierRegistry['connect']>> = null;
  try {
    connected = await registry.connect(db, { id: attempt.supplierId, code: row.code });
  } catch {
    // Credentials that do not decrypt: the same as none (the admin is told by the health job).
  }
  if (!connected) return { status: 'unknown', reason: 'supplier_unavailable' };
  const { adapter, secrets } = connected;
  // The route's map: the supplier's field name → the order's input field key (S07 rule RT3).
  const fields = Object.fromEntries(
    Object.entries(row.fieldMap).map(([name, key]) => [name, row.fields[key] ?? '']),
  );
  const answer = await recordedCall(
    db,
    attempt.supplierId,
    call === 'place' ? 'place_order' : 'get_order',
    () =>
      call === 'place'
        ? adapter.placeOrder({
            idempotencyKey: attempt.id,
            offerId: attempt.supplierOfferId,
            quantity: attempt.quantity,
            fields,
          })
        : adapter.getOrder(attempt.id),
    callResult,
  );
  return attemptOutcome(answer.ok ? answer.value : outcomeOfOrderError(answer.error), secrets);
}
