import {
  EMAIL_PRIORITIES,
  EMAIL_STATUSES,
  EMAIL_TEMPLATES,
  NOTIFICATION_EVENTS,
} from '@vertex-digital/contracts';
import { isNull } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
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

/** The customer's email choice per event (rule NT8); a missing row means on. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    event: notificationEventEnum('event').notNull(),
    email: boolean('email').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.customerId, table.event] })],
);
