import { z } from 'zod';
import { otpCodeSchema } from './auth.js';
import { depositRejectReasonSchema } from './deposits.js';
import { cursorQuerySchema } from './lists.js';
import { tierPrivilegesSchema } from './merchant-tiers.js';
import { alertLineSchema, monthSchema, WATCH_DIGEST_LINES } from './merchant-tools.js';
import {
  ADMIN_ORDER_NOTE_MAX_LENGTH,
  cancelReasonSchema,
  refundReasonSchema,
  STORE_PLACED_PURPOSES,
} from './orders.js';
import { levelTierSchema, merchantTierSchema, priceKindSchema } from './price-kinds.js';
import { adjustmentCategorySchema, adjustmentDirectionSchema } from './wallet.js';

/*
 * Emails, owned by the api `notifications` module (S01 rules E1–E5): every email is a row of the
 * outbox and an `email.send` job, sent by the worker. Emails never carry a password, a link with
 * a token or a free-text value someone else typed (a sign-up name could be spam for a stranger).
 */

export const EMAIL_TEMPLATES = [
  /** The code that verifies a new account's email (rule C1). */
  'customer_verify_email',
  /** The code that resets a forgotten password (rule C7). */
  'customer_reset_password',
  /** The code that confirms a new email address, sent to it (rule C12). */
  'customer_change_email',
  /** To the old address once the email changed (rule C12). */
  'customer_email_changed',
  /** After a password change or reset (rules C7, C11). */
  'customer_password_changed',
  /** After a sign-in, with the device and address (rule C10). */
  'customer_new_sign_in',
  /** S22 PK2: a passkey was added, with its name, the device and the address; always sent. */
  'customer_passkey_added',
  /** Someone tried to sign up, or to move an account, with this address (rules C2, C12). */
  'customer_sign_up_attempt',
  /** The admin adjusted the wallet, or reversed an adjustment (S02); never the reason or note. */
  'customer_wallet_adjusted',
  /** A deposit was approved and credited (S03); the amount, never the transaction number. */
  'customer_deposit_credited',
  /** A deposit was rejected (rule RV6): the reason's words, never the admin's note. */
  'customer_deposit_rejected',
  /** The admin asked for a clearer receipt (rule RV8), never the note. */
  'customer_deposit_receipt_requested',
  /** An order was delivered (S08); never its codes or account fields. */
  'customer_order_delivered',
  /** Part of an order was delivered and the rest refunded (S08). */
  'customer_order_partially_refunded',
  /** An order was refunded in full, with the reason in plain words (S08). */
  'customer_order_refunded',
  /** A reservation was cancelled by the system, with the reason in plain words (S09 RS9). */
  'customer_order_cancelled',
  /** Every order of a checkout finished: the counts and the refund (S10 CT8), never fields. */
  'customer_checkout_finished',
  /** The admin answered a ticket (S12 TK9): the number and a link, never the reply. */
  'customer_ticket_replied',
  /** The store placed an order for the customer (S16 AP11): the mode and the note, no fields. */
  'customer_order_placed_for_you',
  /** S20 MA4: the admin asked for more information about a merchant application. */
  'customer_merchant_info_requested',
  /** S20 MA5, MA6: the account became a merchant. */
  'customer_merchant_approved',
  /** S20 MA4: the application was rejected, with the reason and the first day to reapply. */
  'customer_merchant_rejected',
  /** S20 MA7: the merchant status was withdrawn (never the reason). */
  'customer_merchant_revoked',
  /** S21 LV4: the volume level changed: its name and the price kind, never the list's name. */
  'customer_merchant_level_changed',
  /** S21 AL5: the balance fell below the merchant's threshold. */
  'customer_merchant_low_balance',
  /** S21 AL4: the day's alert events, when the merchant turned the email on (no center row). */
  'customer_merchant_daily_digest',
  /** S21 ST4: last month's statement is ready, with its link. */
  'customer_merchant_statement_ready',
  /** S23 PG3: near the next tier, or below the own tier's threshold, before the month ends. */
  'customer_merchant_tier_reminder',
] as const;

export const emailTemplateSchema = z.enum(EMAIL_TEMPLATES);

export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const EMAIL_PRIORITIES = ['high', 'normal'] as const;

export type EmailPriority = (typeof EMAIL_PRIORITIES)[number];

export const EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;

/**
 * Q29 (owner's delegation, audit A10-46): how long a sent or failed email keeps its address and
 * parameters, and a settled Telegram message its parameters, before `system.purge-outboxes`
 * clears them. The rows stay as the delivery record.
 */
export const OUTBOX_RETENTION_DAYS = 90;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const code = z.object({ code: otpCodeSchema });
const at = z.object({ at: z.iso.datetime() });

const productAlertParams = z.object({
  alertId: z.uuid(),
  productId: z.uuid(),
  productNameAr: z.string(),
  gameSlug: z.string(),
  gameNameAr: z.string(),
});

/*
 * The customer notification center (S05 F27, rules NT1–NT8): one `customer_notifications` row per
 * event, written with `notifyCustomer` in the transaction of the change, live over SSE, and the
 * matching email unless the customer turned it off.
 */

export const NOTIFICATION_EVENTS = [
  'deposit_credited',
  'deposit_rejected',
  'deposit_receipt_requested',
  'wallet_adjusted',
  'order_delivered',
  'order_partially_refunded',
  'order_refunded',
  'order_delayed',
  'order_paid',
  'order_cancelled',
  'checkout_finished',
  'ticket_replied',
  'order_placed_for_you',
  /** S20 AT3: the account's price list changed (center only, never the list's name). */
  'price_list_changed',
  /** S20 MA4–MA7: the merchant application and status. */
  'merchant_info_requested',
  'merchant_approved',
  'merchant_rejected',
  'merchant_application_expired',
  'merchant_revoked',
  /** S21 LV4, AL3, AL5: the merchant tools. */
  'merchant_level_changed',
  'merchant_watch_digest',
  'merchant_low_balance',
  /** S21 ST4: last month's statement. */
  'merchant_statement_ready',
  /** S23 PG3: the month-end tier reminder. */
  'merchant_tier_reminder',
  /** S22 PA4: a pack the customer asked about is available, or cheaper (center and push). */
  'product_available',
  'product_price_dropped',
] as const;

export const notificationEventSchema = z
  .enum(NOTIFICATION_EVENTS)
  .meta({ id: 'NotificationEvent' });

export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/**
 * What each event carries (rule NT3): what the customer needs and nothing more; never notes,
 * transaction numbers, TXIDs or flags. The matching email adds the time it happened.
 */
export const NOTIFICATION_PARAMS = {
  deposit_credited: z.object({
    depositId: z.uuid(),
    referenceCode: z.string(),
    creditedUsdUnits: z.int().positive(),
  }),
  deposit_rejected: z.object({
    depositId: z.uuid(),
    referenceCode: z.string(),
    reason: depositRejectReasonSchema,
  }),
  deposit_receipt_requested: z.object({
    depositId: z.uuid(),
    referenceCode: z.string(),
  }),
  wallet_adjusted: z.object({
    direction: adjustmentDirectionSchema,
    amountUnits: z.int().positive(),
    category: adjustmentCategorySchema,
    reversal: z.boolean(),
  }),
  // S08: the order number and product name, never codes or account field values.
  order_delivered: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
    quantity: z.int().positive(),
  }),
  order_partially_refunded: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
    deliveredQuantity: z.int().positive(),
    refundedQuantity: z.int().positive(),
    /** S16 AP11: null when the owner paid: nothing returns to the wallet. */
    refundedUsdUnits: z.int().positive().nullable(),
  }),
  order_refunded: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
    /** S16 AP11: null when the owner paid ("تعذّر تنفيذ الطلب", no wallet amount). */
    refundedUsdUnits: z.int().positive().nullable(),
    reason: refundReasonSchema,
  }),
  order_delayed: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
  }),
  // S09: a reservation paid after a deposit (rule RS4), or cancelled by the system (rule RS9).
  order_paid: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
  }),
  order_cancelled: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
    reason: cancelReasonSchema.exclude(['customer']),
  }),
  // S10 rule CT8: once, when the last order of a checkout finished.
  checkout_finished: z.object({
    checkoutId: z.uuid(),
    orderCount: z.int().positive(),
    delivered: z.int().nonnegative(),
    partiallyRefunded: z.int().nonnegative(),
    refunded: z.int().nonnegative(),
    refundedUsdUnits: z.int().nonnegative(),
  }),
  // S12 TK9: the ticket, never the message.
  ticket_replied: z.object({ ticketId: z.uuid(), number: z.string() }),
  // S16 AP11: an order the store placed for the customer; never the admin's internal reason.
  order_placed_for_you: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    productNameAr: z.string(),
    purpose: z.enum(STORE_PLACED_PURPOSES),
    /** The order's note to the customer (named apart from internal notes, rule NT3). */
    message: z.string().max(ADMIN_ORDER_NOTE_MAX_LENGTH).optional(),
  }),
  // S20 AT3, AT4: the price kind the account now pays, never a list's name or rule.
  price_list_changed: z.object({ priceKind: priceKindSchema }),
  // S20 MA4–MA7: the admin's message is written to this customer; a revocation's reason is not.
  merchant_info_requested: z.object({ applicationId: z.uuid(), message: z.string() }),
  merchant_approved: z.object({ priceKind: priceKindSchema }),
  merchant_rejected: z.object({
    applicationId: z.uuid(),
    reason: z.string(),
    availableAt: z.iso.datetime(),
  }),
  merchant_application_expired: z.object({ applicationId: z.uuid() }),
  merchant_revoked: z.object({}),
  // S21 LV4: the level's name (null: no level) and the price kind, never the list's name.
  merchant_level_changed: z.object({
    levelNameAr: z.string().nullable(),
    priceKind: priceKindSchema,
    direction: z.enum(['up', 'down']),
    /** S23 TR6: the effective tier now (missing on notifications sent before S23). */
    tier: merchantTierSchema.optional(),
    /** S23 ID4: what the new tier grants (missing before S23 PR 2). */
    privileges: tierPrivilegesSchema.optional(),
  }),
  // S21 AL3: the counts of the hour's changes and up to five of them.
  merchant_watch_digest: z.object({
    priceDown: z.int().nonnegative(),
    priceUp: z.int().nonnegative(),
    backInStock: z.int().nonnegative(),
    outOfStock: z.int().nonnegative(),
    lines: z.array(alertLineSchema).max(WATCH_DIGEST_LINES),
  }),
  // S21 AL5.
  merchant_low_balance: z.object({
    balanceUsdUnits: z.int(),
    thresholdUsdUnits: z.int().positive(),
  }),
  // S21 ST4: the month, `YYYY-MM`.
  merchant_statement_ready: z.object({ month: monthSchema }),
  // S23 PG3: `reach` the next tier, or `keep` the own tier next month, with the amount missing.
  merchant_tier_reminder: z.object({
    kind: z.enum(['reach', 'keep']),
    tier: levelTierSchema,
    missingUsdUnits: z.int().positive(),
    month: monthSchema,
  }),
  // S22 PA4: the pack and its game; a drop adds the customer's own old and new unit prices.
  product_available: productAlertParams,
  product_price_dropped: productAlertParams.extend({
    oldUnitPriceUsdUnits: z.int().positive(),
    newUnitPriceUsdUnits: z.int().positive(),
  }),
} as const satisfies Record<NotificationEvent, z.ZodObject>;

export type NotificationParams<Event extends NotificationEvent> = z.infer<
  (typeof NOTIFICATION_PARAMS)[Event]
>;

/** S21 AL4: the daily email lists at most this many events, then "و n غيرها". */
export const MERCHANT_DAILY_DIGEST_LINES = 50;

/** The parameters each template is rendered with. */
export const EMAIL_PARAMS = {
  customer_verify_email: code,
  customer_reset_password: code,
  customer_change_email: code,
  customer_email_changed: at,
  customer_password_changed: at,
  customer_new_sign_in: at.extend({
    browser: z.string(),
    system: z.string(),
    ipAddress: z.string().nullable(),
  }),
  customer_passkey_added: at.extend({
    name: z.string(),
    browser: z.string(),
    system: z.string(),
    ipAddress: z.string().nullable(),
  }),
  customer_sign_up_attempt: z.object({}),
  customer_wallet_adjusted: NOTIFICATION_PARAMS.wallet_adjusted.extend(at.shape),
  customer_deposit_credited: NOTIFICATION_PARAMS.deposit_credited.extend(at.shape),
  customer_deposit_rejected: NOTIFICATION_PARAMS.deposit_rejected,
  customer_deposit_receipt_requested: NOTIFICATION_PARAMS.deposit_receipt_requested,
  customer_order_delivered: NOTIFICATION_PARAMS.order_delivered.extend(at.shape),
  customer_order_partially_refunded: NOTIFICATION_PARAMS.order_partially_refunded.extend(at.shape),
  customer_order_refunded: NOTIFICATION_PARAMS.order_refunded.extend(at.shape),
  customer_order_cancelled: NOTIFICATION_PARAMS.order_cancelled.extend(at.shape),
  customer_checkout_finished: NOTIFICATION_PARAMS.checkout_finished.extend(at.shape),
  customer_ticket_replied: NOTIFICATION_PARAMS.ticket_replied,
  customer_order_placed_for_you: NOTIFICATION_PARAMS.order_placed_for_you.extend(at.shape),
  customer_merchant_info_requested: NOTIFICATION_PARAMS.merchant_info_requested,
  customer_merchant_approved: NOTIFICATION_PARAMS.merchant_approved,
  customer_merchant_rejected: NOTIFICATION_PARAMS.merchant_rejected,
  customer_merchant_revoked: NOTIFICATION_PARAMS.merchant_revoked.extend(at.shape),
  customer_merchant_level_changed: NOTIFICATION_PARAMS.merchant_level_changed,
  customer_merchant_low_balance: NOTIFICATION_PARAMS.merchant_low_balance.extend(at.shape),
  customer_merchant_daily_digest: z.object({
    total: z.int().positive(),
    lines: z.array(alertLineSchema).max(MERCHANT_DAILY_DIGEST_LINES),
  }),
  customer_merchant_statement_ready: NOTIFICATION_PARAMS.merchant_statement_ready,
  customer_merchant_tier_reminder: NOTIFICATION_PARAMS.merchant_tier_reminder,
} as const satisfies Record<EmailTemplate, z.ZodType>;

export type EmailParams<Template extends EmailTemplate> = z.infer<(typeof EMAIL_PARAMS)[Template]>;

/** Templates that carry a code: high priority, never sent after the code expired (rule E2). */
export const CODE_EMAIL_TEMPLATES = [
  'customer_verify_email',
  'customer_reset_password',
  'customer_change_email',
] as const satisfies readonly EmailTemplate[];

export function isCodeEmail(template: EmailTemplate): boolean {
  return (CODE_EMAIL_TEMPLATES as readonly EmailTemplate[]).includes(template);
}

/** How long an email code is valid (rule C4). */
export const EMAIL_CODE_TTL_SECONDS = 10 * 60;

/**
 * The email each notification event queues, unless the customer turned it off (rule NT1); null
 * for an event that lives in the center only (`order_delayed`, S08; `order_paid`, S09).
 */
export const NOTIFICATION_EMAIL_TEMPLATE = {
  deposit_credited: 'customer_deposit_credited',
  deposit_rejected: 'customer_deposit_rejected',
  deposit_receipt_requested: 'customer_deposit_receipt_requested',
  wallet_adjusted: 'customer_wallet_adjusted',
  order_delivered: 'customer_order_delivered',
  order_partially_refunded: 'customer_order_partially_refunded',
  order_refunded: 'customer_order_refunded',
  order_delayed: null,
  order_paid: null,
  order_cancelled: 'customer_order_cancelled',
  checkout_finished: 'customer_checkout_finished',
  ticket_replied: 'customer_ticket_replied',
  order_placed_for_you: 'customer_order_placed_for_you',
  price_list_changed: null,
  merchant_info_requested: 'customer_merchant_info_requested',
  merchant_approved: 'customer_merchant_approved',
  merchant_rejected: 'customer_merchant_rejected',
  merchant_application_expired: null,
  merchant_revoked: 'customer_merchant_revoked',
  merchant_level_changed: 'customer_merchant_level_changed',
  merchant_watch_digest: null,
  merchant_low_balance: 'customer_merchant_low_balance',
  merchant_statement_ready: 'customer_merchant_statement_ready',
  merchant_tier_reminder: 'customer_merchant_tier_reminder',
  product_available: null,
  product_price_dropped: null,
} as const satisfies Record<NotificationEvent, EmailTemplate | null>;

/** An event that sends an email, which the customer can turn off (rule NT8). */
export type EmailNotificationEvent = {
  [Event in NotificationEvent]: (typeof NOTIFICATION_EMAIL_TEMPLATE)[Event] extends null
    ? never
    : Event;
}[NotificationEvent];

export const EMAIL_NOTIFICATION_EVENTS = NOTIFICATION_EVENTS.filter(
  (event): event is EmailNotificationEvent => NOTIFICATION_EMAIL_TEMPLATE[event] !== null,
);

/**
 * The events that also send a push (S15 rule PD1): every event that has an email (owner,
 * 2026-10-11), and those that have none but push: the hourly follow digest (S21 AL3, decision
 * 11) and the product alerts (S22 PA4).
 */
export type PushNotificationEvent =
  | EmailNotificationEvent
  | 'merchant_watch_digest'
  | 'product_available'
  | 'product_price_dropped';

export const PUSH_NOTIFICATION_EVENTS: readonly PushNotificationEvent[] = [
  ...EMAIL_NOTIFICATION_EVENTS,
  'merchant_watch_digest',
  'product_available',
  'product_price_dropped',
];

export function isPushNotificationEvent(event: NotificationEvent): event is PushNotificationEvent {
  return (PUSH_NOTIFICATION_EVENTS as readonly NotificationEvent[]).includes(event);
}

const notificationBase = {
  id: z.uuid(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
};

const notification = <Event extends NotificationEvent>(event: Event) =>
  z.object({ ...notificationBase, event: z.literal(event), params: NOTIFICATION_PARAMS[event] });

/** One notification as the store shows it; `params` by event (rule NT3). */
export const customerNotificationSchema = z
  .discriminatedUnion('event', [
    notification('deposit_credited'),
    notification('deposit_rejected'),
    notification('deposit_receipt_requested'),
    notification('wallet_adjusted'),
    notification('order_delivered'),
    notification('order_partially_refunded'),
    notification('order_refunded'),
    notification('order_delayed'),
    notification('order_paid'),
    notification('order_cancelled'),
    notification('checkout_finished'),
    notification('ticket_replied'),
    notification('order_placed_for_you'),
    notification('price_list_changed'),
    notification('merchant_info_requested'),
    notification('merchant_approved'),
    notification('merchant_rejected'),
    notification('merchant_application_expired'),
    notification('merchant_revoked'),
    notification('merchant_level_changed'),
    notification('merchant_watch_digest'),
    notification('merchant_low_balance'),
    notification('merchant_statement_ready'),
    notification('merchant_tier_reminder'),
    notification('product_available'),
    notification('product_price_dropped'),
  ])
  .meta({ id: 'CustomerNotification' });

export type CustomerNotification = z.infer<typeof customerNotificationSchema>;

/** `GET /api/notifications`: newest first, 20 a page (rule NT5). */
export const notificationListQuerySchema = cursorQuerySchema
  .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .meta({ id: 'NotificationListQuery' });

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

const unreadCount = { unreadCount: z.int().nonnegative() };

export const notificationPageSchema = z
  .object({
    items: z.array(customerNotificationSchema),
    nextCursor: z.string().nullable(),
    ...unreadCount,
  })
  .meta({ id: 'NotificationPage' });

export type NotificationPage = z.infer<typeof notificationPageSchema>;

/** `POST /api/notifications/read`: everything up to this notification, included (rule NT5). */
export const markNotificationsReadSchema = z
  .object({ upToId: z.uuid() })
  .meta({ id: 'MarkNotificationsRead' });

export type MarkNotificationsRead = z.infer<typeof markNotificationsReadSchema>;

export const unreadCountSchema = z.object(unreadCount).meta({ id: 'UnreadCount' });

export type UnreadCount = z.infer<typeof unreadCountSchema>;

/**
 * The live stream's events (rule NT6), sent as SSE `event:` names with JSON `data:`. `replaced`
 * (S11): a newer stream of the same viewer took this one's place; the client stops instead of
 * reconnecting, which would close the next oldest in turn.
 */
export const NOTIFICATION_STREAM_EVENTS = [
  'unread',
  'notification',
  'order',
  'resync',
  'replaced',
] as const;

export type NotificationStreamEvent = (typeof NOTIFICATION_STREAM_EVENTS)[number];

/** The data of a `notification` stream event: the new notification and the new count. */
export const notificationStreamItemSchema = z.object({
  notification: customerNotificationSchema,
  ...unreadCount,
});

export type NotificationStreamItem = z.infer<typeof notificationStreamItemSchema>;

/**
 * The customer's choice per event and channel (S05 rule NT8, S15 rule PP1): on unless turned off.
 * Both channels list every event; `push` matters only for `PUSH_NOTIFICATION_EVENTS`.
 */
export const notificationPreferencesSchema = z
  .object({
    email: z.record(notificationEventSchema, z.boolean()),
    push: z.record(notificationEventSchema, z.boolean()),
  })
  .meta({ id: 'NotificationPreferences' });

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** One channel per change (S15 rule PP1); push only for an event that sends one. */
export const updateNotificationPreferenceSchema = z
  .union([
    z.strictObject({ event: notificationEventSchema, email: z.boolean() }),
    z.strictObject({
      event: notificationEventSchema.refine(isPushNotificationEvent, {
        message: 'This event sends no push',
      }),
      push: z.boolean(),
    }),
  ])
  .meta({ id: 'UpdateNotificationPreference' });

export type UpdateNotificationPreference = z.infer<typeof updateNotificationPreferenceSchema>;
