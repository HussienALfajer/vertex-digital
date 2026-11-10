import {
  RETURN_REQUEST_STATUSES,
  SHOP_CUSTOMER_ORIGINS,
  SHOP_RATE_MODES,
  SHOP_SETTLEMENT_TARGETS,
  SHOP_STATUSES,
  SHOP_SUSPEND_REASONS,
  SHOP_TRANSFER_CURRENCIES,
  SHOP_TRANSFER_DIRECTIONS,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { catalogGames } from './catalog.js';
import { amountUnits, archivedAt, id, timestamps } from './columns.js';
import { contentPageVersions } from './content.js';
import { priceLists } from './price-lists.js';
import { exchangeRates } from './rates.js';
import { ledgerJournals } from './wallet.js';

/*
 * Merchant shops (S26, ADR 0040), owned by the api `shops` module: the shop and its settings, the
 * shop customers' realm (a third Better Auth instance whose sessions carry their shop), and the
 * merchant's transfers and return requests. Shop wallets are ledger accounts (`wallet.ts`).
 */

export const shopStatusEnum = pgEnum('shop_status', SHOP_STATUSES);
export const shopRateModeEnum = pgEnum('shop_rate_mode', SHOP_RATE_MODES);
export const shopSuspendReasonEnum = pgEnum('shop_suspend_reason', SHOP_SUSPEND_REASONS);
export const shopCustomerOriginEnum = pgEnum('shop_customer_origin', SHOP_CUSTOMER_ORIGINS);
export const shopTransferCurrencyEnum = pgEnum('shop_transfer_currency', SHOP_TRANSFER_CURRENCIES);
export const shopTransferDirectionEnum = pgEnum(
  'shop_transfer_direction',
  SHOP_TRANSFER_DIRECTIONS,
);
/** What a transfer row is: the merchant's transfer, or a return the customer confirmed. */
export const shopTransferCauseEnum = pgEnum('shop_transfer_cause', ['transfer', 'return']);
export const shopSettlementTargetEnum = pgEnum('shop_settlement_target', SHOP_SETTLEMENT_TARGETS);
export const shopReturnRequestStatusEnum = pgEnum(
  'shop_return_request_status',
  RETURN_REQUEST_STATUSES,
);

/** States in which a shop is live: one per merchant, and a slug no other live shop holds (SH1, SH2). */
const LIVE = sql`status in ('requested', 'active', 'suspended')`;

/**
 * One shop per merchant (SH1). Never deleted: a rejected request is archived when the merchant
 * requests again; a closed shop stays, selling to the customers who hold a balance (SH7).
 */
export const merchantShops = pgTable(
  'merchant_shops',
  {
    id: id(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => customers.id),
    slug: text('slug').notNull(),
    status: shopStatusEnum('status').notNull().default('requested'),
    /** The merchant's approved trade name, copied at the request and again on approval. */
    displayName: text('display_name').notNull(),
    brandColor: text('brand_color').notNull(),
    announcement: text('announcement'),
    rateMode: shopRateModeEnum('rate_mode').notNull().default('store'),
    customerBalanceCapUsdUnits: amountUnits('customer_balance_cap_usd_units')
      .notNull()
      .default(200_000_000),
    dailyTransferCapUsdUnits: amountUnits('daily_transfer_cap_usd_units')
      .notNull()
      .default(1_000_000_000),
    customerLimit: integer('customer_limit').notNull().default(2_000),
    /** SH7: the merchant's effective list when the shop closed; a closed shop sells at it. */
    priceListIdAtClose: uuid('price_list_id_at_close').references(() => priceLists.id),
    rejectReason: text('reject_reason'),
    suspendReason: shopSuspendReasonEnum('suspend_reason'),
    /** SH6: the admin's own note, never shown to customers. */
    suspendNote: text('suspend_note'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('merchant_shops_merchant_id_idx').on(table.merchantId),
    uniqueIndex('merchant_shops_live_merchant_idx').on(table.merchantId).where(LIVE),
    uniqueIndex('merchant_shops_live_slug_idx').on(table.slug).where(LIVE),
    index('merchant_shops_slug_idx').on(table.slug),
    index('merchant_shops_status_idx').on(table.status, table.requestedAt.desc()),
    index('merchant_shops_price_list_id_at_close_idx').on(table.priceListIdAtClose),
    check(
      'merchant_shops_slug_check',
      sql`char_length(${table.slug}) between 3 and 30 and ${table.slug} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`,
    ),
    check('merchant_shops_brand_color_check', sql`${table.brandColor} ~ '^#[0-9a-f]{6}$'`),
    check(
      'merchant_shops_display_name_check',
      sql`char_length(${table.displayName}) between 1 and 100`,
    ),
    check(
      'merchant_shops_announcement_check',
      sql`${table.announcement} is null or char_length(${table.announcement}) between 1 and 200`,
    ),
    check(
      'merchant_shops_limits_check',
      sql`${table.customerBalanceCapUsdUnits} > 0 and ${table.customerBalanceCapUsdUnits} % 10000 = 0
        and ${table.dailyTransferCapUsdUnits} > 0 and ${table.dailyTransferCapUsdUnits} % 10000 = 0
        and ${table.customerLimit} > 0`,
    ),
    check(
      'merchant_shops_reasons_check',
      sql`(${table.status} <> 'rejected' or ${table.rejectReason} is not null)
        and (${table.status} <> 'suspended' or (${table.suspendReason} is not null and ${table.suspendNote} is not null))
        and (${table.status} <> 'closed' or ${table.closedAt} is not null)
        and (${table.status} = 'requested' or ${table.decidedAt} is not null)`,
    ),
  ],
);

/**
 * SH2, SH3: every slug a shop ever held (append-only), written when a shop is approved or its
 * slug changes. A slug here is never taken by another merchant, and `/s/<old>` redirects to the
 * merchant's current shop.
 */
export const merchantShopSlugs = pgTable(
  'merchant_shop_slugs',
  {
    slug: text('slug').primaryKey(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => customers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('merchant_shop_slugs_shop_id_idx').on(table.shopId),
    index('merchant_shop_slugs_merchant_id_idx').on(table.merchantId),
  ],
);

/** ST3: the shop's own rates (append-only); the newest is in force while `rate_mode = own`. */
export const merchantShopRates = pgTable(
  'merchant_shop_rates',
  {
    id: id(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    rateSypPerUsd: numeric('rate_syp_per_usd', { precision: 12, scale: 4 }).notNull(),
    /** The store's rate when it was set, for the 10% check; null without one. */
    storeRateId: uuid('store_rate_id').references(() => exchangeRates.id),
    confirmedFar: boolean('confirmed_far').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('merchant_shop_rates_shop_idx').on(table.shopId, table.createdAt.desc()),
    index('merchant_shop_rates_store_rate_id_idx').on(table.storeRateId),
    check('merchant_shop_rates_rate_check', sql`${table.rateSypPerUsd} > 0`),
  ],
);

/** ST6: games the merchant hides; a preference, deleted when unhidden. */
export const merchantShopHiddenGames = pgTable(
  'merchant_shop_hidden_games',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    gameId: uuid('game_id')
      .notNull()
      .references(() => catalogGames.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopId, table.gameId] }),
    index('merchant_shop_hidden_games_game_id_idx').on(table.gameId),
  ],
);

/*
 * The shop customers' realm (ADR 0040): the tables of the third Better Auth instance. Property
 * names are the field names Better Auth expects. An email is unique per shop, not system-wide;
 * the instance's adapter scopes every user and session lookup to the path's shop.
 */

export const shopCustomers = pgTable(
  'shop_customers',
  {
    id: id(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /** E.164, from `phoneSchema`. */
    phone: text('phone').notNull(),
    createdBy: shopCustomerOriginEnum('created_by').notNull(),
    /** CA7: set while the admin keeps the customer from buying, confirming and receiving. */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    frozenReason: text('frozen_reason'),
    termsVersionId: uuid('terms_version_id').references(() => contentPageVersions.id),
    privacyVersionId: uuid('privacy_version_id').references(() => contentPageVersions.id),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('shop_customers_shop_email_idx').on(table.shopId, table.email),
    // Target of the sessions' (user, shop) key: a session belongs to its user's shop.
    unique('shop_customers_id_shop_unique').on(table.id, table.shopId),
    index('shop_customers_shop_created_idx').on(table.shopId, table.createdAt.desc()),
    index('shop_customers_email_idx').on(table.email),
    index('shop_customers_terms_version_id_idx').on(table.termsVersionId),
    index('shop_customers_privacy_version_id_idx').on(table.privacyVersionId),
    check('shop_customers_email_check', sql`${table.email} = lower(${table.email})`),
    check('shop_customers_name_check', sql`char_length(${table.name}) between 1 and 60`),
    check(
      'shop_customers_frozen_check',
      sql`(${table.frozenAt} is null) = (${table.frozenReason} is null)`,
    ),
  ],
);

export const shopCustomerSessions = pgTable(
  'shop_customer_sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    /** The session's shop: checked against the path's shop on every lookup (ADR 0040). */
    shopId: uuid('shop_id').notNull(),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'shop_customer_sessions_user_shop_fk',
      columns: [table.userId, table.shopId],
      foreignColumns: [shopCustomers.id, shopCustomers.shopId],
    }).onDelete('cascade'),
    index('shop_customer_sessions_user_shop_idx').on(table.userId, table.shopId),
    index('shop_customer_sessions_shop_id_idx').on(table.shopId),
  ],
);

/** Sign-in methods of a shop customer: the `credential` provider holds the password hash. */
export const shopCustomerAccounts = pgTable(
  'shop_customer_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => shopCustomers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Better Auth's password hash; never selected outside the shops module's auth service. */
    password: text('password'),
    ...timestamps(),
  },
  (table) => [index('shop_customer_accounts_user_id_idx').on(table.userId)],
);

/**
 * Short-lived values of the shop instance: email codes and invitation tokens, one per identifier
 * (`<purpose>:<shop id>:<email>` or a token's digest), so a new one replaces the previous.
 */
export const shopCustomerVerifications = pgTable(
  'shop_customer_verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('shop_customer_verifications_identifier_idx').on(table.identifier),
    index('shop_customer_verifications_expires_at_idx').on(table.expiresAt),
  ],
);

/** WL5: the merchant's request to take an amount back; only a pending request ends, once. */
export const shopReturnRequests = pgTable(
  'shop_return_requests',
  {
    id: id(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    shopCustomerId: uuid('shop_customer_id')
      .notNull()
      .references(() => shopCustomers.id),
    amountUsdUnits: amountUnits('amount_usd_units').notNull(),
    status: shopReturnRequestStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('shop_return_requests_pending_idx')
      .on(table.shopCustomerId)
      .where(sql`status = 'pending'`),
    index('shop_return_requests_customer_idx').on(table.shopCustomerId, table.createdAt.desc()),
    index('shop_return_requests_shop_id_idx').on(table.shopId),
    index('shop_return_requests_due_idx').on(table.expiresAt).where(sql`status = 'pending'`),
    check(
      'shop_return_requests_amount_check',
      sql`${table.amountUsdUnits} > 0 and ${table.amountUsdUnits} % 10000 = 0`,
    ),
    check(
      'shop_return_requests_decided_check',
      sql`(${table.status} = 'pending') = (${table.decidedAt} is null)`,
    ),
  ],
);

/**
 * WL1, WL5: money between a merchant's wallet and a shop customer's (append-only), one row per
 * `shop_transfer` journal but a settlement's: the merchant's transfer or a confirmed return. The
 * entered amount and the rate are stored as the merchant typed them.
 */
export const shopTransfers = pgTable(
  'shop_transfers',
  {
    id: id(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    shopCustomerId: uuid('shop_customer_id')
      .notNull()
      .references(() => shopCustomers.id),
    cause: shopTransferCauseEnum('cause').notNull(),
    direction: shopTransferDirectionEnum('direction').notNull(),
    amountUsdUnits: amountUnits('amount_usd_units').notNull(),
    enteredCurrency: shopTransferCurrencyEnum('entered_currency').notNull(),
    enteredAmountUnits: amountUnits('entered_amount_units').notNull(),
    rateSypPerUsd: numeric('rate_syp_per_usd', { precision: 12, scale: 4 }),
    journalId: uuid('journal_id')
      .notNull()
      .unique()
      .references(() => ledgerJournals.id),
    returnRequestId: uuid('return_request_id')
      .unique()
      .references(() => shopReturnRequests.id),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('shop_transfers_shop_day_idx').on(table.shopId, table.direction, table.createdAt),
    index('shop_transfers_customer_idx').on(table.shopCustomerId, table.createdAt.desc()),
    check(
      'shop_transfers_amount_check',
      sql`${table.amountUsdUnits} > 0 and ${table.amountUsdUnits} % 10000 = 0 and ${table.enteredAmountUnits} > 0`,
    ),
    check(
      'shop_transfers_cause_check',
      sql`case ${table.cause}
        when 'transfer' then ${table.direction} = 'to_customer' and ${table.returnRequestId} is null
        else ${table.direction} = 'to_merchant' and ${table.returnRequestId} is not null
      end`,
    ),
    check(
      'shop_transfers_entered_check',
      sql`case ${table.enteredCurrency}
        when 'syp' then ${table.rateSypPerUsd} > 0 and ${table.enteredAmountUnits} % 100 = 0
        else ${table.rateSypPerUsd} is null and ${table.enteredAmountUnits} = ${table.amountUsdUnits}
      end`,
    ),
  ],
);

/**
 * WL9: a closed shop's customer balance settled by the admin (append-only), with its journal: a
 * `shop_transfer` back to the merchant's wallet, or an `adjustment` against `adjustments:cash_refund`
 * when the owner pays the customer in cash (ADR 0003). The reason is the audit entry's.
 */
export const shopSettlements = pgTable(
  'shop_settlements',
  {
    id: id(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    shopCustomerId: uuid('shop_customer_id')
      .notNull()
      .references(() => shopCustomers.id),
    target: shopSettlementTargetEnum('target').notNull(),
    amountUsdUnits: amountUnits('amount_usd_units').notNull(),
    journalId: uuid('journal_id')
      .notNull()
      .unique()
      .references(() => ledgerJournals.id),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    /** The single admin, without a foreign key (ADR 0016): the admin row stays replaceable. */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('shop_settlements_customer_idx').on(table.shopCustomerId, table.createdAt.desc()),
    index('shop_settlements_shop_id_idx').on(table.shopId),
    check(
      'shop_settlements_amount_check',
      sql`${table.amountUsdUnits} > 0 and ${table.amountUsdUnits} % 10000 = 0`,
    ),
  ],
);
