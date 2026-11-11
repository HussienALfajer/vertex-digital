import {
  type EmailParams,
  QUEUES,
  SHOP_NOTIFICATION_EMAIL_TEMPLATE,
  SHOP_NOTIFICATION_PARAMS,
  type ShopNotificationEvent,
  type ShopNotificationParams,
} from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { type JobSender, PUSH_SEND_OPTIONS, queueEmail } from '../notifications/index.js';
import {
  merchantShops,
  shopCustomerNotifications,
  shopCustomers,
  shopPushSubscriptions,
} from '../schema/index.js';

export interface ShopNotificationInput<Event extends ShopNotificationEvent> {
  shopCustomerId: string;
  event: Event;
  params: ShopNotificationParams<Event>;
}

/**
 * The only writer of `shop_customer_notifications` (S26 PR9), in the transaction of the change,
 * for the API and the worker: the center row, the event's email in the shop's name («<shop> عبر
 * VERTEX DIGITAL»), and a `push.send-shop` job when the customer has a device in that shop. A
 * rolled-back change leaves no row, no email and no push. Every shop event has its email; a shop
 * customer has no per-event choice in V1.
 */
export async function notifyShopCustomer<Event extends ShopNotificationEvent>(
  tx: Transaction,
  jobs: JobSender,
  input: ShopNotificationInput<Event>,
): Promise<{ notificationId: string; emailId: string }> {
  const params = SHOP_NOTIFICATION_PARAMS[input.event].parse(input.params);
  const [customer] = await tx
    .select({
      email: shopCustomers.email,
      shopId: shopCustomers.shopId,
      shopName: merchantShops.displayName,
      slug: merchantShops.slug,
    })
    .from(shopCustomers)
    .innerJoin(merchantShops, eq(merchantShops.id, shopCustomers.shopId))
    .where(eq(shopCustomers.id, input.shopCustomerId));
  if (!customer) throw new Error(`Shop customer ${input.shopCustomerId} does not exist`);
  const [row] = await tx
    .insert(shopCustomerNotifications)
    .values({
      id: newId(),
      shopCustomerId: input.shopCustomerId,
      shopId: customer.shopId,
      event: input.event,
      params,
    })
    .returning({
      id: shopCustomerNotifications.id,
      createdAt: shopCustomerNotifications.createdAt,
    });
  if (!row) throw new Error('The shop notification was not written');
  const [device] = await tx
    .select({ id: shopPushSubscriptions.id })
    .from(shopPushSubscriptions)
    .where(eq(shopPushSubscriptions.shopCustomerId, input.shopCustomerId))
    .limit(1);
  if (device) {
    await jobs.send(tx, QUEUES.pushSendShop, { notificationId: row.id }, PUSH_SEND_OPTIONS);
  }
  const template = SHOP_NOTIFICATION_EMAIL_TEMPLATE[input.event];
  const emailId = await queueEmail(tx, jobs, {
    to: customer.email,
    template,
    // `queueEmail` checks them against the template; TypeScript cannot pair event and template.
    params: {
      ...params,
      shopName: customer.shopName,
      slug: customer.slug,
      at: row.createdAt.toISOString(),
    } as unknown as EmailParams<typeof template>,
  });
  return { notificationId: row.id, emailId };
}
