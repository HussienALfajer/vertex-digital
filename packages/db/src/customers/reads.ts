import {
  type CustomerMarks,
  type CustomerSignals,
  customerStatus,
  SHARED_IP_WINDOW_DAYS,
  SIGNAL_LIST_MAX,
} from '@vertex-digital/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { customerNotes, customers } from '../schema/index.js';

/*
 * What the panel shows beside a customer (S12 CS5, CS6): the fraud signals and the marks, read by
 * the customer profile, the deposit review page, the order page and the ticket's side panel.
 */

type Executor = Database | Transaction;

interface SharedIpRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  ip_addresses: string[];
  total: number;
}

/**
 * Rule CS5: other customers with the same phone (S01 C6), and other customers with a sign-in in
 * the last 30 days from an IP this customer signed in from in that window. At most 10 of each.
 */
export async function customerSignals(db: Executor, customerId: string): Promise<CustomerSignals> {
  const phoneResult = await db.execute<{ id: string; name: string; email: string; total: number }>(
    sql`select o.id, o.name, o.email, (count(*) over ())::int as total
          from customers c join customers o on o.phone = c.phone and o.id <> c.id
         where c.id = ${customerId}
         order by o.created_at desc
         limit ${SIGNAL_LIST_MAX}`,
  );
  const window = `${SHARED_IP_WINDOW_DAYS} days`;
  const ipResult = await db.execute<SharedIpRow>(
    sql`with mine as (
          select distinct ip_address from customer_sign_ins
           where customer_id = ${customerId} and ip_address is not null
             and created_at > now() - ${window}::interval
        ), others as (
          select s.customer_id, array_agg(distinct s.ip_address order by s.ip_address) as ip_addresses,
                 max(s.created_at) as last_at
            from customer_sign_ins s join mine m on m.ip_address = s.ip_address
           where s.customer_id <> ${customerId} and s.created_at > now() - ${window}::interval
           group by s.customer_id
        )
        select c.id, c.name, c.email, o.ip_addresses, (count(*) over ())::int as total
          from others o join customers c on c.id = o.customer_id
         order by o.last_at desc
         limit ${SIGNAL_LIST_MAX}`,
  );
  const phoneRows = phoneResult.rows;
  const ipRows = ipResult.rows;
  return {
    sharedPhone: {
      count: phoneRows[0]?.total ?? 0,
      customers: phoneRows.map(({ id, name, email }) => ({ id, name, email })),
    },
    sharedIp: {
      count: ipRows[0]?.total ?? 0,
      customers: ipRows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        ipAddresses: row.ip_addresses,
      })),
    },
  };
}

/** The customer's pinned, unarchived note, or null (SN2). */
export async function pinnedNote(
  db: Executor,
  customerId: string,
): Promise<typeof customerNotes.$inferSelect | null> {
  const [note] = await db
    .select()
    .from(customerNotes)
    .where(
      and(
        eq(customerNotes.customerId, customerId),
        eq(customerNotes.pinned, true),
        isNull(customerNotes.archivedAt),
      ),
    )
    .orderBy(desc(customerNotes.createdAt))
    .limit(1);
  return note ?? null;
}

/** Rule CS6: the status, the pinned note and how many other customers the signals list. */
export async function customerMarks(db: Executor, customerId: string): Promise<CustomerMarks> {
  const [customer] = await db
    .select({ frozenAt: customers.frozenAt, archivedAt: customers.archivedAt })
    .from(customers)
    .where(eq(customers.id, customerId));
  const signals = await customerSignals(db, customerId);
  const note = await pinnedNote(db, customerId);
  return {
    status: customer ? customerStatus(customer) : 'active',
    pinnedNote: note?.body ?? null,
    signalsCount: signals.sharedPhone.count + signals.sharedIp.count,
  };
}
