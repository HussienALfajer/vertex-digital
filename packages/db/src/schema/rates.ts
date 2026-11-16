import {
  RATE_DECISION_CHANNELS,
  RATE_OBSERVATION_STATUSES,
  RATE_ORIGINS,
  RATE_SOURCE_KINDS,
  RATE_SUGGESTION_REASONS,
  RATE_SUGGESTION_STATUSES,
  type RateSourceParser,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, id, timestamps } from './columns.js';
import { telegramMessages } from './telegram.js';

/*
 * The USD→SYP exchange rate (S03 rules FX1–FX9, ADR 0003, 0017) and its automatic updates (S27,
 * ADR 0041), owned by the api `rates` module. Every change of the rate or the display step is a
 * new row; the current rate is the newest. Append-only (migration 0010).
 */

export const rateOriginEnum = pgEnum('rate_origin', RATE_ORIGINS);

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: id(),
    /** New Syrian pounds per 1 USD, up to 4 decimals (`exchangeRateSchema`). */
    sypPerUsd: numeric('syp_per_usd', { precision: 12, scale: 4 }).notNull(),
    /** The step SYP displays round to, in SYP units: whole pounds, 1 to 50 (rule FX3). */
    displayStepSypUnits: bigint('display_step_syp_units', { mode: 'number' }).notNull(),
    /** S27: who set it; rows before S27 are `admin`. */
    origin: rateOriginEnum('origin').notNull().default('admin'),
    /**
     * The admin who saved or approved it; null only for an automatic row. No foreign key, as
     * `wallet_adjustments.admin_id`.
     */
    adminId: uuid('admin_id'),
    /** S27: the approved suggestion of a `suggestion` row. */
    suggestionId: uuid('suggestion_id').references((): AnyPgColumn => rateSuggestions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('exchange_rates_created_at_idx').on(table.createdAt.desc()),
    uniqueIndex('exchange_rates_suggestion_idx').on(table.suggestionId),
    check('exchange_rates_rate_check', sql`${table.sypPerUsd} > 0`),
    check(
      'exchange_rates_display_step_check',
      sql`${table.displayStepSypUnits} between 100 and 5000 and ${table.displayStepSypUnits} % 100 = 0`,
    ),
    check(
      'exchange_rates_origin_check',
      sql`(${table.origin} = 'auto') = (${table.adminId} is null)
        and (${table.origin} = 'suggestion') = (${table.suggestionId} is not null)`,
    ),
  ],
);

export const rateSourceKindEnum = pgEnum('rate_source_kind', RATE_SOURCE_KINDS);

/** S27: where the rate is read. Hosts are fixed in code; `handle` is never a URL. Archived. */
export const rateSources = pgTable(
  'rate_sources',
  {
    id: id(),
    kind: rateSourceKindEnum('kind').notNull(),
    /** Shown on cards and in the panel (2–40 characters). */
    label: text('label').notNull(),
    /** A channel username, or a sp-today page path (`isRateSourceHandle`). */
    handle: text('handle').notNull(),
    /** Validated by `rateSourceParserSchema`. */
    parser: jsonb('parser').$type<RateSourceParser>().notNull(),
    enabled: boolean('enabled').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    // One live source per channel or page: Telegram usernames ignore case.
    uniqueIndex('rate_sources_live_handle_idx')
      .on(table.kind, sql`lower(${table.handle})`)
      .where(sql`archived_at is null`),
    check('rate_sources_label_check', sql`char_length(${table.label}) between 2 and 40`),
  ],
);

export const rateObservationStatusEnum = pgEnum(
  'rate_observation_status',
  RATE_OBSERVATION_STATUSES,
);

/** S27: one read of one source per poll. Append-only; purged after 90 days (migration guards). */
export const rateObservations = pgTable(
  'rate_observations',
  {
    id: id(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => rateSources.id),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    /** The post's time, or the page's update time when shown. */
    postedAt: timestamp('posted_at', { withTimezone: true }),
    status: rateObservationStatusEnum('status').notNull(),
    /** In new pounds, after the unit conversion; kept for `out_of_range` too, for the admin. */
    sypPerUsd: numeric('syp_per_usd', { precision: 12, scale: 4 }),
    /** At most 300 characters of the matched line. */
    excerpt: text('excerpt'),
    /** Why a read failed (`timeout`, `http_404`, `redirect`, …); never a URL with a secret. */
    errorCode: text('error_code'),
  },
  (table) => [
    index('rate_observations_source_idx').on(table.sourceId, table.fetchedAt.desc()),
    index('rate_observations_fetched_at_idx').on(table.fetchedAt),
    check(
      'rate_observations_figure_check',
      sql`(${table.status} in ('ok', 'out_of_range')) = (${table.sypPerUsd} is not null)
        and (${table.sypPerUsd} is null or ${table.sypPerUsd} > 0)`,
    ),
    check(
      'rate_observations_excerpt_check',
      sql`${table.excerpt} is null or char_length(${table.excerpt}) <= 300`,
    ),
  ],
);

export const rateSuggestionReasonEnum = pgEnum('rate_suggestion_reason', RATE_SUGGESTION_REASONS);

export const rateSuggestionStatusEnum = pgEnum('rate_suggestion_status', RATE_SUGGESTION_STATUSES);

export const rateDecisionChannelEnum = pgEnum('rate_decision_channel', RATE_DECISION_CHANNELS);

/**
 * S27: a move the automatic path did not apply alone. At most one `pending`; it leaves `pending`
 * once (guard trigger) and is never deleted.
 */
export const rateSuggestions = pgTable(
  'rate_suggestions',
  {
    id: id(),
    proposedSypPerUsd: numeric('proposed_syp_per_usd', { precision: 12, scale: 4 }).notNull(),
    /** The rate in force when proposed. */
    baseRateId: uuid('base_rate_id')
      .notNull()
      .references((): AnyPgColumn => exchangeRates.id),
    /** Signed, against the base rate (`rateChangePercent`). */
    changePercent: numeric('change_percent', { precision: 8, scale: 2 }).notNull(),
    reason: rateSuggestionReasonEnum('reason').notNull(),
    observationIds: uuid('observation_ids').array().notNull(),
    status: rateSuggestionStatusEnum('status').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedChannel: rateDecisionChannelEnum('decided_channel'),
    /** The admin who approved or rejected it; no foreign key, as `exchange_rates.admin_id`. */
    adminId: uuid('admin_id'),
    appliedRateId: uuid('applied_rate_id').references((): AnyPgColumn => exchangeRates.id),
    /** The card in the linked chat, edited when the suggestion ends. */
    telegramMessageId: uuid('telegram_message_id').references(() => telegramMessages.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('rate_suggestions_one_pending_idx').on(table.status).where(sql`status = 'pending'`),
    index('rate_suggestions_created_at_idx').on(table.createdAt.desc(), table.id.desc()),
    index('rate_suggestions_base_rate_idx').on(table.baseRateId),
    index('rate_suggestions_applied_rate_idx').on(table.appliedRateId),
    index('rate_suggestions_telegram_message_idx').on(table.telegramMessageId),
    check('rate_suggestions_rate_check', sql`${table.proposedSypPerUsd} > 0`),
    check(
      'rate_suggestions_decision_check',
      sql`(${table.status} = 'pending') = (${table.decidedAt} is null)
        and (${table.status} in ('approved', 'rejected')) = (${table.decidedChannel} is not null)
        and (${table.status} in ('approved', 'rejected')) = (${table.adminId} is not null)
        and (${table.status} = 'approved') = (${table.appliedRateId} is not null)`,
    ),
  ],
);

/** S27 ST1, ST2: the automatic updates' settings. Append-only versions, the newest in force. */
export const rateSettings = pgTable(
  'rate_settings',
  {
    id: id(),
    autoEnabled: boolean('auto_enabled').notNull(),
    autoMaxMoveBps: integer('auto_max_move_bps').notNull(),
    agreementMaxSpreadBps: integer('agreement_max_spread_bps').notNull(),
    minAgreeingSources: integer('min_agreeing_sources').notNull(),
    driftWindowHours: integer('drift_window_hours').notNull(),
    driftMaxBps: integer('drift_max_bps').notNull(),
    minMoveBps: integer('min_move_bps').notNull(),
    freshnessMinutes: integer('freshness_minutes').notNull(),
    silentAlertHours: integer('silent_alert_hours').notNull(),
    telegramApproveMaxBps: integer('telegram_approve_max_bps').notNull(),
    pollMinutes: integer('poll_minutes').notNull(),
    /** The admin who saved it (or turned updates off from Telegram); no foreign key. */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rate_settings_created_at_idx').on(table.createdAt.desc()),
    // ADR 0041: Telegram never approves a move above 5%, whatever is saved.
    check('rate_settings_telegram_cap_check', sql`${table.telegramApproveMaxBps} <= 500`),
    check('rate_settings_sources_check', sql`${table.minAgreeingSources} >= 2`),
  ],
);
