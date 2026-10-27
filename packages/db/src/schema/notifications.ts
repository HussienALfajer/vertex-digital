import {
  EMAIL_PRIORITIES,
  EMAIL_STATUSES,
  EMAIL_TEMPLATES,
  NOTIFICATION_EVENTS,
} from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customerSessions, customers } from './auth.js';
import { id, timestamps } from './columns.js';

/*
 * The email outbox (S01 rules E1–E5), owned by the api `notifications` module: the API inserts a
 * row and its `email.send` job in the transaction of the change; the worker sends it and records
 * the outcome. A delivery record, not a business record: never archived.
 */

export const emailTemplateEnum = pgEnum('email_template', EMAIL_TEMPLATES);

export const emailPriorityEnum = pgEnum('email_priority', EMAIL_PRIORITIES);

export const emailStatusEnum = pgEnum('email_status', EMAIL_STATUSES);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: id(),
    toAddress: text('to_address').notNull(),
    template: emailTemplateEnum('template').notNull(),
    /** The template's parameters; a code email's are cleared once sent or expired (rule E4). */
    params: jsonb('params'),
    priority: emailPriorityEnum('priority').notNull(),
    status: emailStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** The SMTP error class and message of the last failure; never the body. */
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    customerId: uuid('customer_id').references(() => customers.id),
    /** Code emails: when the code expires; not sent after it (rule E2). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index('email_outbox_status_idx').on(table.status, table.createdAt),
    index('email_outbox_customer_id_idx').on(table.customerId, table.createdAt.desc()),
    // `email.purge-codes`: the code emails whose parameters still wait to be cleared (A07-28).
    index('email_outbox_expiring_idx')
      .on(table.expiresAt)
      .where(sql`${table.params} is not null and ${table.expiresAt} is not null`),
  ],
);

/*
 * The customer notification center (S05 F27, rules NT1–NT8), owned by the api `notifications`
 * module and written only by `notifyCustomer` (`src/notifications`), in the transaction of the
 * change. A delivery record: never archived or deleted; only `read_at` changes (migration 0021).
 */

export const notificationEventEnum = pgEnum('notification_event', NOTIFICATION_EVENTS);

export const customerNotifications = pgTable(
  'customer_notifications',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    event: notificationEventEnum('event').notNull(),
    /** `NOTIFICATION_PARAMS[event]` (rule NT3): never notes, transaction numbers, TXIDs or flags. */
    params: jsonb('params').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customer_notifications_customer_id_idx').on(
      table.customerId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('customer_notifications_unread_idx').on(table.customerId).where(isNull(table.readAt)),
  ],
);

/**
 * The customer's email and push choice per event (S05 rule NT8, S15 rule PP1); a missing row
 * means both on, and a row created by changing one channel takes the default for the other.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    event: notificationEventEnum('event').notNull(),
    email: boolean('email').notNull(),
    push: boolean('push').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.customerId, table.event] })],
);

/*
 * Web push devices (S15 rules PS1–PS8), owned by the api `notifications` module: the API registers
 * and removes them, the worker sends to them. A device registration, not a business record: it goes
 * with the session that registered it (the foreign key), when the customer turns push off on the
 * device, or when the push service says it is gone. `p256dh` and `auth` let a browser decrypt,
 * not anyone push: never logged all the same.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => customerSessions.id, { onDelete: 'cascade' }),
    /** An allowed push service URL (rule PS2), checked by the API and again by the worker. */
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** The first 16 characters of the VAPID public key it was made with (rule PS7). */
    vapidKeyId: text('vapid_key_id').notNull(),
    /** Consecutive transient failures (rule PD5): 20 deletes the row. */
    failures: integer('failures').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(table.endpoint),
    index('push_subscriptions_customer_id_idx').on(table.customerId),
    index('push_subscriptions_session_id_idx').on(table.sessionId),
    check('push_subscriptions_endpoint_length', sql`char_length(${table.endpoint}) <= 1024`),
    check('push_subscriptions_failures', sql`${table.failures} >= 0`),
  ],
);
