import {
  type CustomerFilter,
  type CustomerSearch,
  type CustomerStatus,
  customerStatus,
} from '@vertex-digital/contracts';
import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { type Database, readAll, type Transaction } from '../client.js';
import { customerWalletBalances } from '../ledger/wallet.js';
import {
  auditEntries,
  customerSessions,
  customerSignIns,
  customers,
  deposits,
  orders,
  pushSubscriptions,
  supportTickets,
} from '../schema/index.js';

/*
 * The admin's reads of customers (S12 CS1–CS4), across the customer, order, deposit, ticket and
 * ledger tables: shared here like the dashboard's figures, so the api `customers` module reads
 * through one place. Lists are newest first with a `(created_at, id)` keyset.
 */

type Executor = Database | Transaction;

/** Where a page continues: the last row's time as PostgreSQL wrote it, and its id. */
export interface KeysetPosition {
  at: string;
  id: string;
}

const afterPosition = (
  time: SQL | typeof customers.createdAt,
  id: typeof customers.id,
  at: KeysetPosition,
) =>
  or(
    sql`${time} < ${at.at}::timestamptz`,
    and(sql`${time} = ${at.at}::timestamptz`, sql`${id} < ${at.id}`),
  );

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/** Rule CS1: the condition a classified search puts on `customers`. */
function searchCondition(search: CustomerSearch): SQL | undefined {
  switch (search.kind) {
    case 'order':
      return inArray(
        customers.id,
        sql`(select ${orders.customerId} from ${orders} where ${orders.number} = ${search.number})`,
      );
    case 'deposit':
      return inArray(
        customers.id,
        sql`(select ${deposits.customerId} from ${deposits} where ${deposits.referenceCode} = ${search.referenceCode})`,
      );
    case 'ticket':
      return inArray(
        customers.id,
        sql`(select ${supportTickets.customerId} from ${supportTickets} where ${supportTickets.number} = ${search.number})`,
      );
    case 'email':
      return sql`${customers.email} like ${`${escapeLike(search.prefix)}%`}`;
    case 'phone':
      return search.e164
        ? eq(customers.phone, search.e164)
        : sql`${customers.phone} like ${`%${escapeLike(search.digits)}`}`;
    case 'text': {
      const pattern = `%${escapeLike(search.text)}%`;
      return or(ilike(customers.name, pattern), ilike(customers.email, pattern));
    }
  }
}

function filterCondition(filter: CustomerFilter): SQL | undefined {
  switch (filter) {
    case 'active':
      return and(isNull(customers.archivedAt), isNull(customers.frozenAt));
    case 'frozen':
      return and(isNull(customers.archivedAt), isNotNull(customers.frozenAt));
    case 'archived':
      return isNotNull(customers.archivedAt);
    case 'test':
      return eq(customers.isTest, true);
    case 'all':
      return undefined;
  }
}

export interface CustomerPageRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  isTest: boolean;
  status: CustomerStatus;
  createdAt: Date;
  /** `created_at` as PostgreSQL wrote it, for the cursor. */
  cursorAt: string;
  balanceUnits: number;
  deliveredOrders: number;
  lastOrderAt: Date | null;
}

/** Rules CS1, CS2: one page (and one extra row) of customers, newest first. */
export async function customerPage(
  db: Executor,
  input: {
    search: CustomerSearch | null;
    filter: CustomerFilter;
    after: KeysetPosition | null;
    limit: number;
  },
): Promise<CustomerPageRow[]> {
  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      phone: customers.phone,
      isTest: customers.isTest,
      frozenAt: customers.frozenAt,
      archivedAt: customers.archivedAt,
      createdAt: customers.createdAt,
      cursorAt: sql<string>`${customers.createdAt}::text`,
    })
    .from(customers)
    .where(
      and(
        input.search ? searchCondition(input.search) : undefined,
        filterCondition(input.filter),
        input.after ? afterPosition(customers.createdAt, customers.id, input.after) : undefined,
      ),
    )
    .orderBy(desc(customers.createdAt), desc(customers.id))
    .limit(input.limit + 1);
  const ids = rows.map((row) => row.id);
  const [balances, delivered] = await readAll(db, [
    () => customerWalletBalances(db, ids),
    () =>
      ids.length === 0
        ? []
        : db
            .select({
              customerId: orders.customerId,
              count: sql<number>`(count(*) filter (where ${orders.status} in ('delivered', 'partially_refunded')))::int`,
              lastAt: sql<Date | null>`max(${orders.createdAt})`,
            })
            .from(orders)
            .where(inArray(orders.customerId, ids))
            .groupBy(orders.customerId),
  ]);
  const ordersOf = new Map(delivered.map((row) => [row.customerId, row]));
  return rows.map(({ frozenAt, archivedAt, ...row }) => {
    const facts = ordersOf.get(row.id);
    return {
      ...row,
      status: customerStatus({ frozenAt, archivedAt }),
      balanceUnits: balances.get(row.id) ?? 0,
      deliveredOrders: facts?.count ?? 0,
      lastOrderAt: facts?.lastAt ? new Date(facts.lastAt) : null,
    };
  });
}

export interface CustomerProfileFacts {
  established: boolean;
  balanceUnits: number;
  statusChange: { reason: string | null; at: Date } | null;
  counts: {
    deliveredOrders: number;
    deliveredTotalUsdUnits: number;
    refundedOrders: number;
    creditedDeposits: number;
    creditedTotalUsdUnits: number;
    openTickets: number;
    activeSessions: number;
    reservations: number;
    pushDevices: number;
  };
}

/** Rule CS3: the profile's counts, balance and the reason of the freeze or archive in force. */
export async function customerProfileFacts(
  db: Executor,
  customer: { id: string; frozenAt: Date | null; archivedAt: Date | null },
): Promise<CustomerProfileFacts> {
  const status = customerStatus(customer);
  const [[orderFacts], [depositFacts], [tickets], [sessions], [devices], balances, [change]] =
    await readAll(db, [
      () =>
        db
          .select({
            delivered: sql<number>`(count(*) filter (where ${orders.status} in ('delivered', 'partially_refunded')))::int`,
            deliveredTotal: sql<string>`coalesce(sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits}) filter (where ${orders.status} in ('delivered', 'partially_refunded')), 0)::text`,
            refunded: sql<number>`(count(*) filter (where ${orders.status} = 'refunded'))::int`,
            reservations: sql<number>`(count(*) filter (where ${orders.status} = 'awaiting_balance'))::int`,
          })
          .from(orders)
          .where(eq(orders.customerId, customer.id)),
      () =>
        db
          .select({
            credited: sql<number>`(count(*) filter (where ${deposits.status} = 'credited'))::int`,
            creditedTotal: sql<string>`coalesce(sum(${deposits.creditedUsdUnits}) filter (where ${deposits.status} = 'credited'), 0)::text`,
          })
          .from(deposits)
          .where(eq(deposits.customerId, customer.id)),
      () =>
        db
          .select({ open: sql<number>`count(*)::int` })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.customerId, customer.id),
              sql`${supportTickets.status} <> 'closed'`,
            ),
          ),
      () =>
        db
          .select({ active: sql<number>`count(*)::int` })
          .from(customerSessions)
          .where(
            and(
              eq(customerSessions.userId, customer.id),
              gt(customerSessions.expiresAt, sql`now()`),
            ),
          ),
      // S15: the devices the worker would send to (PD2), whatever their VAPID key.
      () =>
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(pushSubscriptions)
          .innerJoin(customerSessions, eq(customerSessions.id, pushSubscriptions.sessionId))
          .where(
            and(
              eq(pushSubscriptions.customerId, customer.id),
              gt(customerSessions.expiresAt, sql`now()`),
            ),
          ),
      () => customerWalletBalances(db, [customer.id]),
      () =>
        status === 'active'
          ? [undefined]
          : db
              .select({ reason: auditEntries.reason, at: auditEntries.occurredAt })
              .from(auditEntries)
              .where(
                and(
                  eq(auditEntries.entityType, 'customer'),
                  eq(auditEntries.entityId, customer.id),
                  eq(
                    auditEntries.action,
                    status === 'frozen' ? 'customer.frozen' : 'customer.archived',
                  ),
                ),
              )
              .orderBy(desc(auditEntries.occurredAt))
              .limit(1),
    ]);
  const credited = depositFacts?.credited ?? 0;
  return {
    established: credited > 0,
    balanceUnits: balances.get(customer.id) ?? 0,
    statusChange: change ? { reason: change.reason, at: change.at } : null,
    counts: {
      deliveredOrders: orderFacts?.delivered ?? 0,
      deliveredTotalUsdUnits: Number(orderFacts?.deliveredTotal ?? 0),
      refundedOrders: orderFacts?.refunded ?? 0,
      creditedDeposits: credited,
      creditedTotalUsdUnits: Number(depositFacts?.creditedTotal ?? 0),
      openTickets: tickets?.open ?? 0,
      activeSessions: sessions?.active ?? 0,
      reservations: orderFacts?.reservations ?? 0,
      pushDevices: devices?.count ?? 0,
    },
  };
}

/** Rule CS4: the ids whose audit entries make the customer's history. */
export async function customerRecordIds(db: Executor, customerId: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(
    sql`select ${customerId}::uuid as id
        union all select id from orders where customer_id = ${customerId}
        union all select id from deposits where customer_id = ${customerId}
        union all select id from support_tickets where customer_id = ${customerId}`,
  );
  return result.rows.map((row) => row.id);
}

/** Rule CS4: the customer's sessions that have not expired, newest first. */
export async function customerActiveSessions(db: Executor, customerId: string) {
  return db
    .select({
      id: customerSessions.id,
      ipAddress: customerSessions.ipAddress,
      userAgent: customerSessions.userAgent,
      createdAt: customerSessions.createdAt,
      lastActiveAt: customerSessions.updatedAt,
    })
    .from(customerSessions)
    .where(and(eq(customerSessions.userId, customerId), gt(customerSessions.expiresAt, sql`now()`)))
    .orderBy(desc(customerSessions.updatedAt));
}

/** Rule CS4: one page (and one extra row) of the sign-in log, newest first. */
export async function customerSignInRows(
  db: Executor,
  customerId: string,
  page: { after: KeysetPosition | null; limit: number },
) {
  return db
    .select({
      id: customerSignIns.id,
      ipAddress: customerSignIns.ipAddress,
      userAgent: customerSignIns.userAgent,
      createdAt: customerSignIns.createdAt,
      cursorAt: sql<string>`${customerSignIns.createdAt}::text`,
    })
    .from(customerSignIns)
    .where(
      and(
        eq(customerSignIns.customerId, customerId),
        page.after
          ? or(
              sql`${customerSignIns.createdAt} < ${page.after.at}::timestamptz`,
              and(
                sql`${customerSignIns.createdAt} = ${page.after.at}::timestamptz`,
                sql`${customerSignIns.id} < ${page.after.id}`,
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(customerSignIns.createdAt), desc(customerSignIns.id))
    .limit(page.limit + 1);
}
