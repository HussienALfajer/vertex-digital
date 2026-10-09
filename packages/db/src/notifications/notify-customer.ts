import {
  type EmailParams,
  type EmailTemplate,
  NOTIFICATION_EMAIL_TEMPLATE,
  NOTIFICATION_PARAMS,
  type NotificationEvent,
  type NotificationParams,
} from '@vertex-digital/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { customerNotifications, customers, notificationPreferences } from '../schema/index.js';
import { type JobSender, queueEmail } from './email-outbox.js';

/** The `LISTEN` channel of new notifications; the payload is the notification id (rule NT6). */
export const CUSTOMER_NOTIFICATIONS_CHANNEL = 'customer_notifications';

export interface CustomerNotificationInput<Event extends NotificationEvent> {
  customerId: string;
  event: Event;
  params: NotificationParams<Event>;
}

/**
 * The only writer of `customer_notifications` (S05 rule NT1), in the transaction of the change,
 * for the API and the worker: the row, the matching email unless the customer turned it off
 * (rule NT8), and a `pg_notify` that PostgreSQL delivers only at commit. A rolled-back change
 * leaves no row, no email and no event.
 */
export async function notifyCustomer<Event extends NotificationEvent>(
  tx: Transaction,
  jobs: JobSender,
  input: CustomerNotificationInput<Event>,
): Promise<{ notificationId: string; emailId: string | null }> {
  const params = NOTIFICATION_PARAMS[input.event].parse(input.params);
  const [row] = await tx
    .insert(customerNotifications)
    .values({ id: newId(), customerId: input.customerId, event: input.event, params })
    .returning({ id: customerNotifications.id, createdAt: customerNotifications.createdAt });
  if (!row) throw new Error('The notification was not written');
  await tx.execute(sql`select pg_notify(${CUSTOMER_NOTIFICATIONS_CHANNEL}, ${row.id})`);
  // An event of the center only (`order_delayed`, S08) sends no email.
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
