import {
  ORDER_PROBLEMS,
  TICKET_AUTHORS,
  TICKET_CATEGORIES,
  TICKET_CLOSERS,
  TICKET_STATUSES,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { id, timestamps } from './columns.js';
import { deposits } from './deposits.js';
import { storedFiles } from './files.js';
import { orders } from './orders.js';

/*
 * Support tickets (S12 F23), owned by the api `support` module. A ticket is closed, never archived
 * or deleted; its messages and attachments are append-only (migration 0043): the conversation is a
 * record.
 */

export const ticketCategoryEnum = pgEnum('ticket_category', TICKET_CATEGORIES);

export const ticketStatusEnum = pgEnum('ticket_status', TICKET_STATUSES);

export const ticketAuthorEnum = pgEnum('ticket_author', TICKET_AUTHORS);

export const ticketCloserEnum = pgEnum('ticket_closer', TICKET_CLOSERS);

export const orderProblemEnum = pgEnum('order_problem', ORDER_PROBLEMS);

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: id(),
    /** `VT-` and 6 characters of the order number alphabet. */
    number: text('number').notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    category: ticketCategoryEnum('category').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    depositId: uuid('deposit_id').references(() => deposits.id),
    subject: text('subject').notNull(),
    status: ticketStatusEnum('status').notNull(),
    openedBy: ticketAuthorEnum('opened_by').notNull(),
    lastCustomerMessageAt: timestamp('last_customer_message_at', { withTimezone: true }),
    lastAdminMessageAt: timestamp('last_admin_message_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: ticketCloserEnum('closed_by'),
    /** S22 OP5: the problem named at opening, an order ticket's only; never changed. */
    orderProblem: orderProblemEnum('order_problem'),
    ...timestamps(),
  },
  (table) => [
    index('support_tickets_customer_idx').on(table.customerId, table.updatedAt.desc()),
    index('support_tickets_queue_idx').on(table.status, table.lastCustomerMessageAt),
    index('support_tickets_auto_close_idx').on(table.status, table.lastAdminMessageAt),
    // One ticket that is not closed per order and per deposit (TK1, TK4, TK5).
    uniqueIndex('support_tickets_open_order_idx')
      .on(table.orderId)
      .where(sql`${table.status} <> 'closed'`),
    uniqueIndex('support_tickets_open_deposit_idx')
      .on(table.depositId)
      .where(sql`${table.status} <> 'closed'`),
    // Plain indexes for the foreign keys, closed tickets included (edge case 12).
    index('support_tickets_order_idx').on(table.orderId),
    index('support_tickets_deposit_idx').on(table.depositId),
    check('support_tickets_number_check', sql`${table.number} ~ '^VT-[2-9A-HJKMNP-Z]{6}$'`),
    check('support_tickets_subject_check', sql`char_length(${table.subject}) between 3 and 120`),
    check(
      'support_tickets_link_check',
      sql`(${table.category} = 'order') = (${table.orderId} is not null) and (${table.category} = 'deposit') = (${table.depositId} is not null)`,
    ),
    check(
      'support_tickets_order_problem_check',
      sql`${table.orderProblem} is null or ${table.category} = 'order'`,
    ),
    index('support_tickets_order_problem_idx')
      .on(table.orderProblem, table.lastCustomerMessageAt)
      .where(sql`${table.orderProblem} is not null`),
    check(
      'support_tickets_closed_check',
      sql`(${table.status} = 'closed') = (${table.closedAt} is not null and ${table.closedBy} is not null) and (${table.closedAt} is null) = (${table.closedBy} is null)`,
    ),
  ],
);

/** Append-only (TK7): a ticket's conversation, plain text. */
export const supportMessages = pgTable(
  'support_messages',
  {
    id: id(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => supportTickets.id),
    author: ticketAuthorEnum('author').notNull(),
    body: text('body').notNull(),
    /** The request's `Idempotency-Key` (a UUID, unique like an order's). */
    idempotencyKey: uuid('idempotency_key').unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('support_messages_ticket_idx').on(table.ticketId, table.createdAt),
    check('support_messages_body_check', sql`char_length(${table.body}) between 1 and 2000`),
  ],
);

/** Append-only (TK11): up to 3 images per message, each file used once. */
export const supportAttachments = pgTable(
  'support_attachments',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => supportMessages.id),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => storedFiles.id),
    position: smallint('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.position] }),
    check('support_attachments_position_check', sql`${table.position} between 1 and 3`),
  ],
);

/** One row (SC1): the Telegram support link, empty until the admin sets it. */
export const supportSettings = pgTable(
  'support_settings',
  {
    id: integer('id').primaryKey(),
    telegramUrl: text('telegram_url'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('support_settings_one_row_check', sql`${table.id} = 1`),
    check(
      'support_settings_telegram_url_check',
      sql`${table.telegramUrl} is null or ${table.telegramUrl} ~ '^https://t\\.me/[A-Za-z0-9_]{5,32}$'`,
    ),
  ],
);
