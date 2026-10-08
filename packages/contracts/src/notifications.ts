import { z } from 'zod';
import { otpCodeSchema } from './auth.js';
import { depositRejectReasonSchema } from './deposits.js';
import { cursorQuerySchema } from './lists.js';
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
] as const;

export const emailTemplateSchema = z.enum(EMAIL_TEMPLATES);

export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const EMAIL_PRIORITIES = ['high', 'normal'] as const;

export type EmailPriority = (typeof EMAIL_PRIORITIES)[number];

export const EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

const code = z.object({ code: otpCodeSchema });
const at = z.object({ at: z.iso.datetime() });

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
} as const satisfies Record<NotificationEvent, z.ZodObject>;

export type NotificationParams<Event extends NotificationEvent> = z.infer<
  (typeof NOTIFICATION_PARAMS)[Event]
>;

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
  customer_sign_up_attempt: z.object({}),
  customer_wallet_adjusted: NOTIFICATION_PARAMS.wallet_adjusted.extend(at.shape),
  customer_deposit_credited: NOTIFICATION_PARAMS.deposit_credited.extend(at.shape),
  customer_deposit_rejected: NOTIFICATION_PARAMS.deposit_rejected,
  customer_deposit_receipt_requested: NOTIFICATION_PARAMS.deposit_receipt_requested,
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

/** The email each notification event queues, unless the customer turned it off (rule NT1). */
export const NOTIFICATION_EMAIL_TEMPLATE = {
  deposit_credited: 'customer_deposit_credited',
  deposit_rejected: 'customer_deposit_rejected',
  deposit_receipt_requested: 'customer_deposit_receipt_requested',
  wallet_adjusted: 'customer_wallet_adjusted',
} as const satisfies Record<NotificationEvent, EmailTemplate>;

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

/** The live stream's events (rule NT6), sent as SSE `event:` names with JSON `data:`. */
export const NOTIFICATION_STREAM_EVENTS = ['unread', 'notification', 'resync'] as const;

export type NotificationStreamEvent = (typeof NOTIFICATION_STREAM_EVENTS)[number];

/** The data of a `notification` stream event: the new notification and the new count. */
export const notificationStreamItemSchema = z.object({
  notification: customerNotificationSchema,
  ...unreadCount,
});

export type NotificationStreamItem = z.infer<typeof notificationStreamItemSchema>;

/** The customer's email choice per event (rule NT8): on unless turned off. */
export const notificationPreferencesSchema = z
  .object({ email: z.record(notificationEventSchema, z.boolean()) })
  .meta({ id: 'NotificationPreferences' });

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferenceSchema = z
  .object({ event: notificationEventSchema, email: z.boolean() })
  .meta({ id: 'UpdateNotificationPreference' });

export type UpdateNotificationPreference = z.infer<typeof updateNotificationPreferenceSchema>;
