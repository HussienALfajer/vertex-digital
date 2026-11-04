import { createHash } from 'node:crypto';
import {
  type CashHoldState,
  CREDIT_POLICY_DEFAULTS,
  CREDIT_WINDOW_HOURS,
  type CreditLimits,
  type CreditPolicy,
  cashEligibleBalance,
  cashNeedsApproval,
  cashTelegramDecides,
  creditLimitRefusal,
  creditRemaining,
  maskRecipient,
  type RecipientOrders,
  recipientNeedsAlert,
  type SectionAmounts,
  type ServiceClass,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, gt, inArray, lte, ne, notInArray, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Executor, Transaction } from '../client.js';
import { accountBalance, ensureCustomerWallet, findCustomerWallet } from '../ledger/index.js';
import {
  catalogGames,
  creditPolicy,
  customers,
  ledgerJournals,
  ledgerPostings,
  orders,
} from '../schema/index.js';
import { damascusDate } from '../suppliers/validations.js';
import { queueTelegramMessage } from '../telegram/queue-telegram-message.js';
import { OrderError } from './errors.js';
import { refundRemaining } from './outcome.js';
import {
  addOrderEvent,
  lockOrder,
  type OrderContext,
  type OrderRow,
  queueFulfil,
} from './transition.js';

/*
 * Syrian credit, bills and cash (S25 CL1–CL6, CS1–CS5, ADR 0039): the section's limits, counted
 * under the recipients' advisory locks and the wallet lock, and the cash hold's decisions.
 */

/** Statuses that never count against a limit (CL2): nothing was or will be charged. */
const NOT_COUNTED = ['cancelled', 'refunded'] as const;

const HOUR = 3_600_000;

/** The credit policy in force: the newest `credit_policy` row (the seed at least). */
export async function currentCreditPolicy(db: Executor): Promise<CreditPolicy> {
  const [row] = await db
    .select()
    .from(creditPolicy)
    .orderBy(desc(creditPolicy.createdAt), desc(creditPolicy.id))
    .limit(1);
  if (!row) return CREDIT_POLICY_DEFAULTS;
  const { id: _, adminId: __, createdAt: ___, ...policy } = row;
  return policy;
}

/** A line of the section, as the limits read it. */
export interface SectionLine {
  serviceClass: Exclude<ServiceClass, 'none'>;
  recipient: string;
  totalUsdUnits: number;
}

/**
 * CL5: one transaction at a time per number, taken in a fixed order before the wallet lock, so two
 * accounts racing on one number cannot both pass CL3.
 */
export async function lockRecipients(tx: Transaction, recipients: readonly string[]) {
  for (const recipient of [...new Set(recipients)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`recipient:${recipient}`}))`);
  }
}

const since = (hours: number) => sql`now() - ${`${hours} hours`}::interval`;

/**
 * CL2, CS2: the customer's section and cash orders of the last 24 hours, their kept part (a partly
 * refunded order counts what it kept); `excludeOrderId` leaves out a reservation being paid.
 */
export async function sectionSpent(
  db: Executor,
  customerId: string,
  excludeOrderId?: string,
): Promise<SectionAmounts> {
  const kept = sql<number>`coalesce(sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits}), 0)`;
  const rows = await db
    .select({ serviceClass: catalogGames.serviceClass, amount: kept.mapWith(Number) })
    .from(orders)
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(
      and(
        eq(orders.customerId, customerId),
        gt(orders.createdAt, since(CREDIT_WINDOW_HOURS)),
        sql`${orders.recipient} is not null`,
        notInArray(orders.status, [...NOT_COUNTED]),
        excludeOrderId ? ne(orders.id, excludeOrderId) : undefined,
      ),
    )
    .groupBy(catalogGames.serviceClass);
  let sectionUsdUnits = 0;
  let cashUsdUnits = 0;
  for (const row of rows) {
    sectionUsdUnits += row.amount;
    if (row.serviceClass === 'cash') cashUsdUnits += row.amount;
  }
  return { sectionUsdUnits, cashUsdUnits };
}

/** CL3: each number's orders of the last 24 hours, from every account. */
async function recipientCounts(
  db: Executor,
  recipients: readonly string[],
  excludeOrderId?: string,
): Promise<Map<string, number>> {
  if (recipients.length === 0) return new Map();
  const rows = await db
    .select({ recipient: orders.recipient, count: sql<number>`count(*)`.mapWith(Number) })
    .from(orders)
    .where(
      and(
        inArray(orders.recipient, [...new Set(recipients)]),
        gt(orders.createdAt, since(CREDIT_WINDOW_HOURS)),
        notInArray(orders.status, [...NOT_COUNTED]),
        excludeOrderId ? ne(orders.id, excludeOrderId) : undefined,
      ),
    )
    .groupBy(orders.recipient);
  return new Map(rows.map((row) => [row.recipient as string, row.count]));
}

/**
 * CS1: the wallet balance less the deposits and adding adjustments credited within the policy's
 * age, and when the oldest of those becomes old enough (null when none waits). Refunds of the
 * customer's own orders are not counted.
 */
export async function cashEligibility(
  db: Executor,
  walletId: string,
  policy: Pick<CreditPolicy, 'cashBalanceAgeHours'>,
): Promise<{ eligibleUsdUnits: number; moreAt: Date | null }> {
  const [balance, [recent]] = [
    await accountBalance(db as Transaction, walletId),
    await db
      .select({
        amount: sql<number>`coalesce(sum(${ledgerPostings.amountUnits}), 0)`.mapWith(Number),
        oldest: sql<Date | null>`min(${ledgerJournals.createdAt})`,
      })
      .from(ledgerPostings)
      .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
      .where(
        and(
          eq(ledgerPostings.accountId, walletId),
          gt(ledgerPostings.amountUnits, 0),
          inArray(ledgerJournals.kind, ['deposit', 'adjustment']),
          gt(ledgerJournals.createdAt, since(policy.cashBalanceAgeHours)),
        ),
      ),
  ];
  const oldest = recent?.oldest ? new Date(recent.oldest) : null;
  return {
    eligibleUsdUnits: cashEligibleBalance(balance, recent?.amount ?? 0),
    moreAt: oldest && new Date(oldest.getTime() + policy.cashBalanceAgeHours * HOUR),
  };
}

/**
 * CL2, CL3, CS1, CS2 under the wallet lock the caller holds, after `lockRecipients`: refuses with
 * the first limit the lines would break (`CREDIT_DAILY_LIMIT`, `RECIPIENT_DAILY_LIMIT`,
 * `CASH_DAILY_LIMIT`, `CASH_BALANCE_TOO_RECENT`). Nothing is read for a purchase outside the
 * section.
 */
export async function checkCreditLimits(
  tx: Transaction,
  input: {
    policy: CreditPolicy;
    customerId: string;
    merchant: boolean;
    walletId: string;
    lines: readonly SectionLine[];
    /** CL6: the reservation being paid, already counted at its creation. */
    excludeOrderId?: string;
  },
): Promise<void> {
  if (input.lines.length === 0) return;
  const adding: SectionAmounts = { sectionUsdUnits: 0, cashUsdUnits: 0 };
  const perRecipient = new Map<string, number>();
  for (const line of input.lines) {
    adding.sectionUsdUnits += line.totalUsdUnits;
    if (line.serviceClass === 'cash') adding.cashUsdUnits += line.totalUsdUnits;
    perRecipient.set(line.recipient, (perRecipient.get(line.recipient) ?? 0) + 1);
  }
  const spent = await sectionSpent(tx, input.customerId, input.excludeOrderId);
  const counts = await recipientCounts(tx, [...perRecipient.keys()], input.excludeOrderId);
  const recipients: RecipientOrders[] = [...perRecipient].map(([recipient, count]) => ({
    recipient,
    existing: counts.get(recipient) ?? 0,
    adding: count,
  }));
  const cash =
    adding.cashUsdUnits > 0
      ? await cashEligibility(tx, input.walletId, input.policy)
      : { eligibleUsdUnits: 0, moreAt: null };
  const refusal = creditLimitRefusal({
    policy: input.policy,
    merchant: input.merchant,
    spent,
    adding,
    recipients,
    cashEligibleUsdUnits: cash.eligibleUsdUnits,
  });
  if (!refusal) return;
  const { code, ...details } = refusal;
  throw new OrderError(code, 'A limit of the credit section would be passed', {
    ...details,
    ...(code === 'CASH_BALANCE_TOO_RECENT' && {
      eligibleMoreAt: cash.moreAt?.toISOString() ?? null,
    }),
  });
}

/** `GET /api/credit-limits`: what the customer may still spend in the section now. */
export async function creditLimitsFor(db: Database, customerId: string): Promise<CreditLimits> {
  return db.transaction(
    async (tx) => {
      const [customer] = await tx
        .select({ accountType: customers.accountType })
        .from(customers)
        .where(eq(customers.id, customerId));
      const policy = await currentCreditPolicy(tx);
      const spent = await sectionSpent(tx, customerId);
      const remaining = creditRemaining(policy, customer?.accountType === 'merchant', spent);
      const wallet = await findCustomerWallet(tx, customerId);
      const cash = wallet
        ? await cashEligibility(tx, wallet, policy)
        : { eligibleUsdUnits: 0, moreAt: null };
      return {
        sectionRemainingUsdUnits: remaining.sectionUsdUnits,
        cashRemainingUsdUnits: remaining.cashUsdUnits,
        cashEligibleUsdUnits: cash.eligibleUsdUnits,
        cashEligibleMoreAt: cash.moreAt?.toISOString() ?? null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** CS3: the hold a new cash order takes, or null (not cash, or within the threshold). */
export function cashHoldFor(
  policy: CreditPolicy,
  line: { serviceClass: ServiceClass; totalUsdUnits: number },
  merchant: boolean,
): 'held' | null {
  return line.serviceClass === 'cash' && cashNeedsApproval(policy, merchant, line.totalUsdUnits)
    ? 'held'
    : null;
}

/**
 * After a section order is written (CS3, CL4): its Telegram card when held, and the recipient's
 * alert when more accounts than the policy allows ordered to it within its days (once a number a
 * Damascus day; the dedupe key holds a digest, never the number).
 */
export async function afterSectionOrder(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  policy: CreditPolicy,
  order: OrderRow,
): Promise<void> {
  if (order.recipient === null) return;
  if (order.cashHold === 'held') await queueCashHoldCard(tx, context, policy, order);
  const accounts = await tx
    .select({
      customerEmail: customers.email,
      total: sql<number>`sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits})`.mapWith(Number),
    })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.recipient, order.recipient),
        gt(orders.createdAt, since(policy.recipientAlertDays * 24)),
        ne(orders.status, 'cancelled'),
      ),
    )
    .groupBy(customers.email)
    .orderBy(asc(customers.email))
    .limit(20);
  if (!recipientNeedsAlert(policy, accounts.length)) return;
  const digest = createHash('sha256').update(order.recipient).digest('hex').slice(0, 32);
  await queueTelegramMessage(tx, context.jobs, {
    kind: 'credit_recipient_alert',
    dedupeKey: `credit-recipient:${digest}:${damascusDate(context.now)}`,
    params: {
      recipientMasked: maskRecipient(order.recipient),
      days: policy.recipientAlertDays,
      accounts: accounts.map((row) => ({
        customerEmail: row.customerEmail,
        totalUsdUnits: Math.max(0, row.total),
      })),
    },
  });
}

/** CS3: the admin's card with the customer's 30-day history and, within the ceiling, buttons. */
async function queueCashHoldCard(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  policy: CreditPolicy,
  order: OrderRow,
): Promise<void> {
  const customerId = order.customerId as string;
  const [customer] = await tx
    .select({
      email: customers.email,
      accountType: customers.accountType,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  const [game] = await tx
    .select({ nameAr: catalogGames.nameAr })
    .from(catalogGames)
    .where(eq(catalogGames.id, order.gameId));
  const wallet = await ensureCustomerWallet(tx, customerId);
  const [deposits] = await tx
    .select({
      amount: sql<number>`coalesce(sum(${ledgerPostings.amountUnits}), 0)`.mapWith(Number),
    })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(
      and(
        eq(ledgerPostings.accountId, wallet),
        eq(ledgerJournals.kind, 'deposit'),
        gt(ledgerJournals.createdAt, since(30 * 24)),
      ),
    );
  const [cash] = await tx
    .select({
      amount:
        sql<number>`coalesce(sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits}), 0)`.mapWith(
          Number,
        ),
    })
    .from(orders)
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(catalogGames.serviceClass, 'cash'),
        gt(orders.createdAt, since(30 * 24)),
        notInArray(orders.status, [...NOT_COUNTED]),
      ),
    );
  const createdAt = customer?.createdAt ?? context.now;
  await queueTelegramMessage(tx, context.jobs, {
    kind: 'cash_hold',
    dedupeKey: `cash-hold:${order.id}`,
    params: {
      orderId: order.id,
      orderNumber: order.number,
      customerEmail: customer?.email ?? '',
      merchant: customer?.accountType === 'merchant',
      accountAgeDays: Math.max(
        0,
        Math.floor((context.now.getTime() - createdAt.getTime()) / (24 * HOUR)),
      ),
      gameNameAr: game?.nameAr ?? '',
      totalUsdUnits: order.totalUsdUnits,
      recipientMasked: maskRecipient(order.recipient as string),
      deposits30dUsdUnits: Math.max(0, deposits?.amount ?? 0),
      cash30dUsdUnits: Math.max(0, cash?.amount ?? 0),
      telegramDecides: cashTelegramDecides(policy, order.totalUsdUnits),
    },
  });
}

/** Who decides a hold: the admin from the panel or Telegram, or the system on expiry (CS5). */
export type CashHoldDecider =
  | {
      kind: 'admin';
      adminId: string;
      channel: 'admin' | 'telegram';
      ipAddress?: string | null;
      userAgent?: string | null;
    }
  | { kind: 'system' };

/**
 * CS4, CS5 in the caller's transaction: the order `FOR UPDATE`, still `paid` and `held` (else
 * `ORDER_NOT_DECIDABLE`), and from Telegram within the policy's ceiling. `approve` marks it and
 * queues fulfilment; `reject` and the system's expiry refund it whole (`cash_rejected`); each with
 * its event and audit entry.
 */
export async function decideCashHold(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs'>,
  input: { orderId: string; decision: 'approve' | 'reject'; reason?: string; by: CashHoldDecider },
): Promise<OrderRow> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new OrderError('NOT_FOUND', 'No such order');
  if (order.cashHold !== 'held' || order.status !== 'paid') {
    throw new OrderError('ORDER_NOT_DECIDABLE', 'The order is not held for approval', {
      cashHold: order.cashHold,
      status: order.status,
    });
  }
  const policy = await currentCreditPolicy(tx);
  if (
    input.by.kind === 'admin' &&
    input.by.channel === 'telegram' &&
    !cashTelegramDecides(policy, order.totalUsdUnits)
  ) {
    throw new OrderError('ORDER_NOT_DECIDABLE', 'Above the Telegram ceiling: the panel only', {
      reason: 'panel_only',
    });
  }
  const admin = input.by.kind === 'admin' ? input.by : null;
  const state: CashHoldState =
    input.decision === 'approve' ? 'approved' : admin ? 'rejected' : 'expired';
  const [marked] = await tx
    .update(orders)
    .set({
      cashHold: state,
      cashHoldDecidedAt: sql`now()`,
      cashHoldAdminId: admin?.adminId ?? null,
    })
    .where(and(eq(orders.id, order.id), eq(orders.cashHold, 'held')))
    .returning();
  if (!marked) throw new Error(`Order ${order.id} changed under its lock`);
  await addOrderEvent(tx, order.id, 'note', {
    actor: admin ? 'admin' : 'system',
    actorId: admin?.adminId ?? null,
    reason: `cash_${state}`,
  });
  const audit = {
    actorKind: admin ? 'admin' : 'system',
    actorId: admin?.adminId ?? null,
    channel: admin ? admin.channel : 'worker',
    entityType: 'order',
    entityId: order.id,
    reason: input.reason ?? null,
    ipAddress: admin?.ipAddress ?? null,
    userAgent: admin?.userAgent ?? null,
  } as const;
  if (state === 'approved') {
    await recordAudit(tx, {
      ...audit,
      action: 'order.cash_approved',
      details: { totalUsdUnits: order.totalUsdUnits },
    });
    await queueFulfil(tx, context.jobs, order.id);
    return marked;
  }
  const refunded = await refundRemaining(tx, context, marked, 'cash_rejected', {
    actor: admin ? 'admin' : 'system',
    actorId: admin?.adminId ?? null,
    ...(input.reason && { reason: input.reason }),
  });
  await recordAudit(tx, {
    ...audit,
    action: 'order.cash_rejected',
    details: {
      totalUsdUnits: order.totalUsdUnits,
      expired: state === 'expired',
      journalId: refunded.refundJournalId as string,
    },
  });
  return refunded;
}

/**
 * CS5: refunds up to `limit` holds older than the policy's hours, each in its own transaction,
 * `FOR UPDATE SKIP LOCKED` so a decision in progress keeps its order. Safe to run twice: the
 * decision's guard refuses an order no longer held.
 */
export async function expireCashHolds(
  db: Database,
  context: Pick<OrderContext, 'jobs'>,
  limit: number,
): Promise<string[]> {
  const policy = await currentCreditPolicy(db);
  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.cashHold, 'held'),
        eq(orders.status, 'paid'),
        lte(orders.paidAt, since(policy.cashHoldHours)),
      ),
    )
    .orderBy(asc(orders.paidAt))
    .limit(limit);
  const expired: string[] = [];
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [free] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.cashHold, 'held'), eq(orders.status, 'paid')))
        .for('update', { skipLocked: true });
      if (!free) return false;
      await decideCashHold(tx, context, {
        orderId: id,
        decision: 'reject',
        by: { kind: 'system' },
      });
      return true;
    });
    if (done) expired.push(id);
  }
  return expired;
}
