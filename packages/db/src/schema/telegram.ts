import {
  TELEGRAM_MESSAGE_KINDS,
  TELEGRAM_MESSAGE_STATUSES,
  TELEGRAM_PROMPT_KINDS,
} from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, id, timestamps } from './columns.js';
import { deposits } from './deposits.js';

/*
 * The Telegram admin bot (S05 F07, ADR 0019), owned by the api `telegram` module. Admins are
 * referenced without a foreign key, as everywhere, so the single admin row stays replaceable.
 * Telegram ids fit in 52 bits: JS numbers.
 */

/**
 * The admin's linked chat (rule TG3). At most one live link: the bot talks to one private chat.
 * Unlinking or a new link sets `unlinked_at`; rows stay as the history.
 */
export const telegramLinks = pgTable(
  'telegram_links',
  {
    id: id(),
    adminId: uuid('admin_id').notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    /** At linking time; shown in the panel only. */
    telegramUsername: text('telegram_username'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('telegram_links_live_idx')
      .using('btree', sql`(true)`)
      .where(isNull(table.unlinkedAt)),
  ],
);

/** One-time link codes (rule TG3): only the SHA-256 of the code is stored. */
export const telegramLinkCodes = pgTable(
  'telegram_link_codes',
  {
    id: id(),
    adminId: uuid('admin_id').notNull(),
    codeSha256: bytea('code_sha256').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('telegram_link_codes_sha256_check', sql`octet_length(${table.codeSha256}) = 32`),
  ],
);

export const telegramMessageKindEnum = pgEnum('telegram_message_kind', TELEGRAM_MESSAGE_KINDS);

export const telegramMessageStatusEnum = pgEnum(
  'telegram_message_status',
  TELEGRAM_MESSAGE_STATUSES,
);

/**
 * The bot's outbox: every message the bot sends is a row and a `telegram.send` job, written in
 * the transaction that causes it; the worker sends it. A delivery record, never archived.
 */
export const telegramMessages = pgTable(
  'telegram_messages',
  {
    id: id(),
    kind: telegramMessageKindEnum('kind').notNull(),
    /** Validated by `TELEGRAM_MESSAGE_PARAMS`. */
    params: jsonb('params').notNull(),
    /** `switch:<changeId>`: a second insert with the same key is ignored. */
    dedupeKey: text('dedupe_key').unique(),
    /**
     * A chat other than the live link's: the answer to `/start` from a chat not linked yet, the
     * notice to the previous chat (rule TG3). Null sends to the live link at send time.
     */
    chatId: bigint('chat_id', { mode: 'number' }),
    status: telegramMessageStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** The error class and Telegram's description; never the token or the text. */
    lastError: text('last_error'),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('telegram_messages_created_at_idx').on(table.createdAt.desc())],
);

/** Updates already handled (rule TG5): a redelivery finds its id and does nothing. */
export const telegramUpdates = pgTable('telegram_updates', {
  updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const telegramPromptKindEnum = pgEnum('telegram_prompt_kind', TELEGRAM_PROMPT_KINDS);

/** The bot's open question (rule TG7): at most one open; opening one closes the others. */
export const telegramPrompts = pgTable(
  'telegram_prompts',
  {
    id: id(),
    kind: telegramPromptKindEnum('kind').notNull(),
    /** The deposit of an approval or rejection prompt, and the submission it was opened on. */
    depositId: uuid('deposit_id').references(() => deposits.id),
    depositSubmittedAt: timestamp('deposit_submitted_at', { withTimezone: true }),
    /** Validated by `TELEGRAM_PROMPT_DATA`. */
    data: jsonb('data').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('telegram_prompts_open_idx')
      .using('btree', sql`(true)`)
      .where(isNull(table.closedAt)),
    index('telegram_prompts_deposit_id_idx').on(table.depositId),
    check(
      'telegram_prompts_deposit_check',
      sql`(${table.depositId} is null) = (${table.depositSubmittedAt} is null)
        and (${table.depositId} is not null) = (${table.kind} <> 'stop_confirm')`,
    ),
  ],
);

/**
 * A deposit's card in the linked chat (rules TC1–TC6): one per submission, so a clearer-receipt
 * round gives a new card. Edited to the outcome by `telegram.deposit-card`.
 */
export const telegramDepositCards = pgTable(
  'telegram_deposit_cards',
  {
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id),
    /** The deposit's `submitted_at` this card shows. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    /** Set when a review reminder listed the deposit (rule RM3). */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.depositId, table.submittedAt] })],
);

/** The bot's own state, one row (rule RM3): when the last review reminder was sent. */
export const telegramBotState = pgTable(
  'telegram_bot_state',
  {
    id: smallint('id').primaryKey(),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
  },
  (table) => [check('telegram_bot_state_one_row', sql`${table.id} = 1`)],
);
