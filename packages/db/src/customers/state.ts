import {
  type ArchiveBlocker,
  type CustomerLimitOverrides,
  type CustomerStatus,
  customerStatus,
  type ErrorCode,
  OPEN_APPLICATION_STATUSES,
} from '@vertex-digital/contracts';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Transaction } from '../client.js';
import { accountBalance, lockCustomerWallet } from '../ledger/index.js';
import type { JobSender } from '../notifications/index.js';
import { cancelReservation } from '../orders/reservations.js';
import {
  customerLimits,
  customerSessions,
  customers,
  deposits,
  merchantApplications,
  orders,
  supportTickets,
} from '../schema/index.js';
import { customerLimitOverrides } from './guard.js';

/*
 * The admin's changes to a customer's state (S12 CF1, CF6, LM5, AR1–AR3, SN1), shared write paths
 * because they touch the `auth` module's customer rows, orders, sessions and tickets in one
 * transaction: the customer row locked `FOR NO KEY UPDATE` first (purchases read it `FOR SHARE`), the
 * change, and its audit entry.
 */

/** A coded refusal of a state change; the API answers its code. */
export class CustomerError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'CustomerError';
    this.code = code;
    this.details = details;
  }
}

/** The admin who acts, as the audit entry records it. */
export interface AdminActor {
  adminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export type CustomerRow = typeof customers.$inferSelect;

/** Orders that block an archive (AR1): money is reserved or moving. */
const OPEN_ORDER_STATUSES = [
  'awaiting_balance',
  'paid',
  'sent_to_supplier',
  'failed',
  'needs_review',
] as const;

/**
 * The customer row `FOR NO KEY UPDATE`, or `NOT_FOUND`: it waits for purchases' `FOR SHARE` (and
 * they for it), but not for the foreign-key checks of rows that name the customer (notifications,
 * emails, orders), which other transactions take while holding an order, wallet or ticket lock.
 */
export async function lockCustomer(tx: Transaction, customerId: string): Promise<CustomerRow> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .for('no key update');
  if (!row) throw new CustomerError('NOT_FOUND', 'No such customer');
  return row;
}

function refuse(status: CustomerStatus): never {
  throw new CustomerError('CUSTOMER_STATE_INVALID', 'The customer is not in a state for this', {
    status,
  });
}

function entry(actor: AdminActor, customerId: string, reason: string) {
  return {
    actorKind: 'admin',
    actorId: actor.adminId,
    channel: 'admin',
    entityType: 'customer',
    entityId: customerId,
    reason,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  } as const;
}

/**
 * Rule CF1: freezes an active customer and cancels every reservation (reason `frozen`, the
 * customer told by `order_cancelled`). Refuses an archived or frozen customer.
 */
export async function freezeCustomer(
  tx: Transaction,
  context: { jobs: JobSender },
  input: { customerId: string; reason: string; actor: AdminActor },
): Promise<{ cancelledOrderIds: string[] }> {
  const customer = await lockCustomer(tx, input.customerId);
  const status = customerStatus(customer);
  if (status !== 'active') refuse(status);
  await tx.update(customers).set({ frozenAt: sql`now()` }).where(eq(customers.id, customer.id));
  const reserved = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.customerId, customer.id), eq(orders.status, 'awaiting_balance')))
    .orderBy(asc(orders.id))
    .for('update');
  const cancelledOrderIds: string[] = [];
  for (const order of reserved) {
    const cancelled = await cancelReservation(tx, context, order, 'frozen', { kind: 'system' });
    if (cancelled) cancelledOrderIds.push(cancelled.id);
  }
  await recordAudit(tx, {
    ...entry(input.actor, customer.id, input.reason),
    action: 'customer.frozen',
    details: { cancelledOrderIds },
  });
  return { cancelledOrderIds };
}

/** Rule CF6: unfreezes a frozen customer; cancelled reservations stay cancelled. */
export async function unfreezeCustomer(
  tx: Transaction,
  input: { customerId: string; reason: string; actor: AdminActor },
): Promise<void> {
  const customer = await lockCustomer(tx, input.customerId);
  const status = customerStatus(customer);
  if (status !== 'frozen') refuse(status);
  await tx.update(customers).set({ frozenAt: null }).where(eq(customers.id, customer.id));
  await recordAudit(tx, {
    ...entry(input.actor, customer.id, input.reason),
    action: 'customer.unfrozen',
    details: {},
  });
}

/** Rule LM5: upserts the overrides with before and after; refused for an archived customer. */
export async function setCustomerLimits(
  tx: Transaction,
  input: {
    customerId: string;
    limits: CustomerLimitOverrides;
    reason: string;
    actor: AdminActor;
  },
): Promise<CustomerLimitOverrides> {
  const customer = await lockCustomer(tx, input.customerId);
  const status = customerStatus(customer);
  if (status === 'archived') refuse(status);
  const before = await customerLimitOverrides(tx, customer.id);
  await tx
    .insert(customerLimits)
    .values({ customerId: customer.id, ...input.limits })
    // Audit A07-25: `$onUpdate` is not applied to an upsert's conflict branch.
    .onConflictDoUpdate({
      target: customerLimits.customerId,
      set: { ...input.limits, updatedAt: sql`now()` },
    });
  await recordAudit(tx, {
    ...entry(input.actor, customer.id, input.reason),
    action: 'customer.limits_changed',
    details: { before, after: input.limits },
  });
  return input.limits;
}

/** Rule AR1: what keeps a customer from being archived, under the customer and wallet locks. */
export async function archiveBlockers(
  tx: Transaction,
  customerId: string,
): Promise<ArchiveBlocker[]> {
  const blockers: ArchiveBlocker[] = [];
  const wallet = await lockCustomerWallet(tx, customerId);
  if ((await accountBalance(tx, wallet)) !== 0) blockers.push('balance');
  const [openOrder] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), inArray(orders.status, [...OPEN_ORDER_STATUSES])))
    .limit(1);
  if (openOrder) blockers.push('open_orders');
  const [openDeposit] = await tx
    .select({ id: deposits.id })
    .from(deposits)
    .where(
      and(eq(deposits.customerId, customerId), inArray(deposits.status, ['pending', 'submitted'])),
    )
    .limit(1);
  if (openDeposit) blockers.push('open_deposits');
  const [openApplication] = await tx
    .select({ id: merchantApplications.id })
    .from(merchantApplications)
    .where(
      and(
        eq(merchantApplications.customerId, customerId),
        inArray(merchantApplications.status, [...OPEN_APPLICATION_STATUSES]),
      ),
    )
    .limit(1);
  if (openApplication) blockers.push('open_merchant_application');
  return blockers;
}

/**
 * Rules AR1, AR2: archives a customer with a zero balance and nothing open: every session deleted,
 * every open ticket closed by the system, one audit entry per ticket and one for the customer.
 */
export async function archiveCustomer(
  tx: Transaction,
  input: { customerId: string; reason: string; actor: AdminActor },
): Promise<{ sessions: number; closedTicketIds: string[] }> {
  const customer = await lockCustomer(tx, input.customerId);
  const status = customerStatus(customer);
  if (status === 'archived') refuse(status);
  const blockers = await archiveBlockers(tx, customer.id);
  if (blockers.length > 0) {
    throw new CustomerError('CUSTOMER_NOT_ARCHIVABLE', 'The customer cannot be archived yet', {
      blockers,
    });
  }
  await tx.update(customers).set({ archivedAt: sql`now()` }).where(eq(customers.id, customer.id));
  const sessions = await tx
    .delete(customerSessions)
    .where(eq(customerSessions.userId, customer.id))
    .returning({ id: customerSessions.id });
  const open = await tx
    .select({
      id: supportTickets.id,
      category: supportTickets.category,
      status: supportTickets.status,
    })
    .from(supportTickets)
    .where(and(eq(supportTickets.customerId, customer.id), ne(supportTickets.status, 'closed')))
    .orderBy(asc(supportTickets.id))
    .for('update');
  if (open.length > 0) {
    await tx
      .update(supportTickets)
      .set({ status: 'closed', closedAt: sql`now()`, closedBy: 'system' })
      .where(
        inArray(
          supportTickets.id,
          open.map((ticket) => ticket.id),
        ),
      );
  }
  for (const ticket of open) {
    await recordAudit(tx, {
      actorKind: 'system',
      actorId: null,
      channel: 'admin',
      action: 'ticket.closed',
      entityType: 'support_ticket',
      entityId: ticket.id,
      details: {
        ticketId: ticket.id,
        category: ticket.category,
        before: ticket.status,
        after: 'closed',
        cause: 'archive',
      },
    });
  }
  const closed = open;
  await recordAudit(tx, {
    ...entry(input.actor, customer.id, input.reason),
    action: 'customer.archived',
    details: { count: sessions.length, closedTicketIds: closed.map((ticket) => ticket.id) },
  });
  return { sessions: sessions.length, closedTicketIds: closed.map((ticket) => ticket.id) };
}

/** Rule AR3: unarchives an archived customer; the customer signs in again. */
export async function unarchiveCustomer(
  tx: Transaction,
  input: { customerId: string; reason: string; actor: AdminActor },
): Promise<void> {
  const customer = await lockCustomer(tx, input.customerId);
  const status = customerStatus(customer);
  if (status !== 'archived') refuse(status);
  await tx.update(customers).set({ archivedAt: null }).where(eq(customers.id, customer.id));
  await recordAudit(tx, {
    ...entry(input.actor, customer.id, input.reason),
    action: 'customer.unarchived',
    details: {},
  });
}

/** Rule SN1: deletes every session of the customer, in any status. */
export async function revokeCustomerSessions(
  tx: Transaction,
  input: { customerId: string; reason: string; actor: AdminActor },
): Promise<number> {
  const customer = await lockCustomer(tx, input.customerId);
  const sessions = await tx
    .delete(customerSessions)
    .where(eq(customerSessions.userId, customer.id))
    .returning({ id: customerSessions.id });
  await recordAudit(tx, {
    ...entry(input.actor, customer.id, input.reason),
    action: 'customer.sessions_revoked_by_admin',
    details: { count: sessions.length },
  });
  return sessions.length;
}

/** For reads outside a transaction (the profile): the customer row, or null. */
export async function findCustomer(
  db: Database | Transaction,
  customerId: string,
): Promise<CustomerRow | null> {
  const [row] = await db.select().from(customers).where(eq(customers.id, customerId));
  return row ?? null;
}
