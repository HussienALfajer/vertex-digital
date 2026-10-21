import {
  type EmailParams,
  type EmailTemplate,
  isPushNotificationEvent,
  NOTIFICATION_EMAIL_TEMPLATE,
  NOTIFICATION_PARAMS,
  type NotificationEvent,
  type NotificationParams,
  QUEUES,
} from '@vertex-digital/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  customerNotifications,
  customers,
  notificationPreferences,
  pushSubscriptions,
} from '../schema/index.js';
import { type JobSender, queueEmail } from './email-outbox.js';

/** The `LISTEN` channel of new notifications; the payload is the notification id (rule NT6). */
export const CUSTOMER_NOTIFICATIONS_CHANNEL = 'customer_notifications';

/** S09 rule LT2: every order status change, from the `orders_notify` trigger (migration 0035). */
export const CUSTOMER_ORDERS_CHANNEL = 'customer_orders';

export interface CustomerNotificationInput<Event extends NotificationEvent> {
  customerId: string;
  event: Event;
  params: NotificationParams<Event>;
}

/**
 * The only writer of `customer_notifications` (S05 rule NT1), in the transaction of the change,
 * for the API and the worker: the row, the matching email unless the customer turned it off
 * (rule NT8) or the caller writes the center row only (`email: false`, S10 rule CT8: the orders
 * of a checkout), a `push.send` job when the customer has a push device (S15 rule PD1; the worker
 * reads the push preference at send time), and a `pg_notify` that PostgreSQL delivers only at
 * commit. A rolled-back change leaves no row, no email, no push and no event.
 */
export async function notifyCustomer<Event extends NotificationEvent>(
  tx: Transaction,
  jobs: JobSender,
  input: CustomerNotificationInput<Event>,
  options: { email?: boolean } = {},
): Promise<{ notificationId: string; emailId: string | null }> {
  const params = NOTIFICATION_PARAMS[input.event].parse(input.params);
  const [row] = await tx
    .insert(customerNotifications)
    .values({ id: newId(), customerId: input.customerId, event: input.event, params })
    .returning({ id: customerNotifications.id, createdAt: customerNotifications.createdAt });
  if (!row) throw new Error('The notification was not written');
  await tx.execute(sql`select pg_notify(${CUSTOMER_NOTIFICATIONS_CHANNEL}, ${row.id})`);
  // A center-only call (S10 CT8) sends neither email nor push.
  if (options.email === false) return { notificationId: row.id, emailId: null };
  if (isPushNotificationEvent(input.event)) await queuePush(tx, jobs, input.customerId, row.id);
  // An event of the center only (`order_delayed`, S08) sends no email; S21's follow digest
  // (`merchant_watch_digest`) sends a push without one.
  const template: EmailTemplate | null = NOTIFICATION_EMAIL_TEMPLATE[input.event];
  if (template === null) return { notificationId: row.id, emailId: null };

  const [customer] = await tx
    .select({ email: customers.email, emailOn: notificationPreferences.email })
    .from(customers)
    .leftJoin(
      notificationPreferences,
      and(
        eq(notificationPreferences.customerId, customers.id),
        eq(notificationPreferences.event, input.event),
      ),
    )
    .where(eq(customers.id, input.customerId));
  if (!customer) throw new Error(`Customer ${input.customerId} does not exist`);
  // A missing preference means on (owner, 2026-10-08).
  if (customer.emailOn === false) return { notificationId: row.id, emailId: null };
  const emailId = await queueEmail(tx, jobs, {
    to: customer.email,
    template,
    // The email's `at`, where its template shows one, is the time of the notification.
    // `queueEmail` checks them against the template; TypeScript cannot pair event and template.
    params: { ...params, at: row.createdAt.toISOString() } as EmailParams<typeof template>,
    customerId: input.customerId,
  });
  return { notificationId: row.id, emailId };
}

/** pg-boss retries off (S15 rule PD5): the job queues its own retry of the failed devices. */
export const PUSH_SEND_OPTIONS: SendOptions = { retryLimit: 0 };

/**
 * S15 rule PD1: one `push.send` job when the customer has at least one device; none when push is
 * not configured, since no device can exist then. The preference and the devices' sessions are
 * read by the worker at send time (PD2), so a change between now and then applies.
 */
async function queuePush(
  tx: Transaction,
  jobs: JobSender,
  customerId: string,
  notificationId: string,
): Promise<void> {
  const [device] = await tx
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.customerId, customerId))
    .limit(1);
  if (device) await jobs.send(tx, QUEUES.pushSend, { notificationId }, PUSH_SEND_OPTIONS);
}
