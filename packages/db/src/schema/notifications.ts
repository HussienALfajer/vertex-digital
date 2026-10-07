import { EMAIL_PRIORITIES, EMAIL_STATUSES, EMAIL_TEMPLATES } from '@vertex-digital/contracts';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
