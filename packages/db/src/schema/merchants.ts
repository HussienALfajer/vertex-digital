import {
  GOVERNORATES,
  HEARD_FROM,
  LEVEL_SOURCES,
  MERCHANT_ACTIVITIES,
  MERCHANT_APPLICATION_EVENTS,
  MERCHANT_APPLICATION_STATUSES,
  MERCHANT_TIERS,
  MONTHLY_VOLUMES,
  PRODUCT_INTERESTS,
  SALES_CHANNELS,
  TIER_CHANGE_SOURCES,
  TIER_GRANT_END_REASONS,
  YEARS_IN_BUSINESS,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { amountUnits, archivedAt, id, timestamps } from './columns.js';
import { contentPageVersions } from './content.js';
import { storedFiles } from './files.js';
import { priceLists } from './price-lists.js';

/*
 * Merchant accounts (S20 F28, ADR 0035), owned by the api `merchants` module: applications and
 * their timeline, the shop photos customers upload for them, the merchant profiles and the merchant
 * settings. The account type and list are columns of `customers` (auth).
 */

export const merchantActivityEnum = pgEnum('merchant_activity', MERCHANT_ACTIVITIES);
export const yearsInBusinessEnum = pgEnum('years_in_business', YEARS_IN_BUSINESS);
export const governorateEnum = pgEnum('governorate', GOVERNORATES);
export const monthlyVolumeEnum = pgEnum('monthly_volume', MONTHLY_VOLUMES);
export const productInterestEnum = pgEnum('product_interest', PRODUCT_INTERESTS);
export const salesChannelEnum = pgEnum('sales_channel', SALES_CHANNELS);
export const heardFromEnum = pgEnum('heard_from', HEARD_FROM);
export const merchantApplicationStatusEnum = pgEnum(
  'merchant_application_status',
  MERCHANT_APPLICATION_STATUSES,
);
export const merchantApplicationEventEnum = pgEnum(
  'merchant_application_event',
  MERCHANT_APPLICATION_EVENTS,
);

/** S23 TR1 (ADR 0038). */
export const merchantTierEnum = pgEnum('merchant_tier', MERCHANT_TIERS);
export const merchantLevelSourceEnum = pgEnum('merchant_level_source', LEVEL_SOURCES);
export const merchantTierChangeSourceEnum = pgEnum(
  'merchant_tier_change_source',
  TIER_CHANGE_SOURCES,
);
export const merchantTierGrantEndReasonEnum = pgEnum(
  'merchant_tier_grant_end_reason',
  TIER_GRANT_END_REASONS,
);

const stampedAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`);

/**
 * MA3: a shop photo and the customer who uploaded it; append-only. A photo is served to that
 * customer and the admin only, and used by at most one application (its unique index there).
 */
export const merchantShopPhotos = pgTable(
  'merchant_shop_photos',
  {
    fileId: uuid('file_id')
      .primaryKey()
      .references(() => storedFiles.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    createdAt: stampedAt(),
  },
  (table) => [
    index('merchant_shop_photos_customer_id_idx').on(table.customerId, table.createdAt.desc()),
  ],
);

/**
 * MA1–MA8: never deleted, closed by a final status (`merchant_applications_guard`, migration
 * 0081: transitions only on MA4's table, the form only on a resubmission). One open application per
 * customer.
 */
export const merchantApplications = pgTable(
  'merchant_applications',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    status: merchantApplicationStatusEnum('status').notNull().default('under_review'),
    tradeName: text('trade_name').notNull(),
    activity: merchantActivityEnum('activity').notNull(),
    activityOther: text('activity_other'),
    yearsInBusiness: yearsInBusinessEnum('years_in_business').notNull(),
    governorate: governorateEnum('governorate').notNull(),
    city: text('city').notNull(),
    streetAddress: text('street_address').notNull(),
    /** E.164 from `phoneSchema`. */
    whatsapp: text('whatsapp').notNull(),
    telegramUsername: text('telegram_username'),
    monthlyVolume: monthlyVolumeEnum('monthly_volume').notNull(),
    productInterests: productInterestEnum('product_interests').array().notNull(),
    salesChannels: salesChannelEnum('sales_channels').array().notNull(),
    shopPhotoFileId: uuid('shop_photo_file_id').references(() => merchantShopPhotos.fileId),
    shopLink: text('shop_link'),
    /** The `merchant_terms` version accepted at submission (MT2), again on a resubmission. */
    termsVersionId: uuid('terms_version_id')
      .notNull()
      .references(() => contentPageVersions.id),
    heardFrom: heardFromEnum('heard_from'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** The information requested or the rejection reason, as the customer reads it. */
    adminMessage: text('admin_message'),
    approvedPriceListId: uuid('approved_price_list_id').references(() => priceLists.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    infoRequestedAt: timestamp('info_requested_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('merchant_applications_open_idx')
      .on(table.customerId)
      .where(sql`${table.status} in ('under_review', 'info_requested')`),
    index('merchant_applications_status_submitted_idx').on(table.status, table.submittedAt),
    index('merchant_applications_customer_idx').on(table.customerId, table.createdAt.desc()),
    uniqueIndex('merchant_applications_shop_photo_idx').on(table.shopPhotoFileId),
    index('merchant_applications_terms_version_id_idx').on(table.termsVersionId),
    index('merchant_applications_approved_price_list_id_idx').on(table.approvedPriceListId),
    check(
      'merchant_applications_text_check',
      sql`char_length(${table.tradeName}) between 2 and 80
        and char_length(${table.city}) between 2 and 60
        and char_length(${table.streetAddress}) between 5 and 160
        and (${table.activityOther} is null or char_length(${table.activityOther}) between 2 and 80)
        and (${table.shopLink} is null or (char_length(${table.shopLink}) <= 300 and ${table.shopLink} like 'https://%'))
        and (${table.adminMessage} is null or char_length(${table.adminMessage}) between 5 and 500)`,
    ),
    check(
      'merchant_applications_activity_other_check',
      sql`(${table.activity} = 'other') = (${table.activityOther} is not null)`,
    ),
    check(
      'merchant_applications_telegram_check',
      sql`${table.telegramUsername} is null or ${table.telegramUsername} ~ '^[A-Za-z0-9_]{5,32}$'`,
    ),
    check(
      'merchant_applications_choices_check',
      sql`cardinality(${table.productInterests}) between 1 and 3
        and cardinality(${table.salesChannels}) between 1 and 4`,
    ),
    check(
      'merchant_applications_approved_check',
      sql`(${table.status} = 'approved') = (${table.approvedPriceListId} is not null)`,
    ),
  ],
);

/** The customer's timeline of an application (MA4): append-only. */
export const merchantApplicationEvents = pgTable(
  'merchant_application_events',
  {
    id: id(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => merchantApplications.id),
    event: merchantApplicationEventEnum('event').notNull(),
    /** The admin's text the customer reads; null for the customer's own events. */
    message: text('message'),
    createdAt: stampedAt(),
  },
  (table) => [
    index('merchant_application_events_application_idx').on(table.applicationId, table.createdAt),
  ],
);

/**
 * S21 LV1, S23 TR1: the volume levels the admin sets; a business table, archived. One live level
 * per tier above Bronze (`tier`, unique among live levels; null only on levels archived before
 * S23: `merchant_levels_tier_check` in migration 0105, added after it archives the S21 levels);
 * names (the tier's) and thresholds are unique among live levels. The list's chain and the
 * thresholds' order are checked by the API under the levels' advisory lock.
 */
export const merchantLevels = pgTable(
  'merchant_levels',
  {
    id: id(),
    tier: merchantTierEnum('tier'),
    nameAr: text('name_ar').notNull(),
    monthlyThresholdUsdUnits: amountUnits('monthly_threshold_usd_units').notNull(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('merchant_levels_name_idx')
      .on(table.nameAr)
      .where(sql`${table.archivedAt} is null`),
    uniqueIndex('merchant_levels_threshold_idx')
      .on(table.monthlyThresholdUsdUnits)
      .where(sql`${table.archivedAt} is null`),
    uniqueIndex('merchant_levels_tier_idx').on(table.tier).where(sql`${table.archivedAt} is null`),
    index('merchant_levels_price_list_id_idx').on(table.priceListId),
    check(
      'merchant_levels_check',
      sql`char_length(${table.nameAr}) between 2 and 30
        and ${table.monthlyThresholdUsdUnits} >= 1000000
        and ${table.monthlyThresholdUsdUnits} % 1000000 = 0`,
    ),
  ],
);

/**
 * A merchant's profile (MA5–MA7), keyed by customer: upserted on a grant, `revoked_at` set on a
 * revocation (the audit log keeps the history).
 */
export const merchantProfiles = pgTable(
  'merchant_profiles',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customers.id),
    tradeName: text('trade_name').notNull(),
    governorate: governorateEnum('governorate').notNull(),
    city: text('city').notNull(),
    /** Null for a direct grant (MA6). */
    applicationId: uuid('application_id').references(() => merchantApplications.id),
    /** Null until a directly granted merchant accepts the terms in force (MT2). */
    termsVersionId: uuid('terms_version_id').references(() => contentPageVersions.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * S21 LV4, S23 TR3: the effective level (earned or granted), what prices, privileges and the
     * badge follow; written by the level recomputation only; null for none (Bronze).
     */
    levelId: uuid('level_id').references(() => merchantLevels.id),
    levelChangedAt: timestamp('level_changed_at', { withTimezone: true }),
    /** S23 TR2: the level the purchases earn; null for none. */
    earnedLevelId: uuid('earned_level_id').references(() => merchantLevels.id),
    /** S23 TR3: where the effective level comes from; null with no level. */
    levelSource: merchantLevelSourceEnum('level_source'),
    /** S23 ID4: the celebration sheet is due; set on a rise by the recomputation, cleared by the merchant. */
    celebratePending: boolean('celebrate_pending').notNull().default(false),
    /**
     * S23 ID7: the certificate's public code, 22 base64url characters from the same generator as
     * the orders' verification codes (migration 0086); the default backfills existing profiles.
     * The merchant reissues it (`certificate_reissued_at`).
     */
    certificateCode: text('certificate_code')
      .notNull()
      .unique()
      .default(sql`order_verification_code()`),
    certificateReissuedAt: timestamp('certificate_reissued_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('merchant_profiles_application_id_idx').on(table.applicationId),
    index('merchant_profiles_terms_version_id_idx').on(table.termsVersionId),
    index('merchant_profiles_level_id_idx').on(table.levelId),
    index('merchant_profiles_earned_level_id_idx').on(table.earnedLevelId),
    // The merchants list's order (audit A10-43, A06-31).
    index('merchant_profiles_granted_at_idx').on(table.grantedAt.desc(), table.customerId.desc()),
    check(
      'merchant_profiles_text_check',
      sql`char_length(${table.tradeName}) between 2 and 80 and char_length(${table.city}) between 2 and 60`,
    ),
  ],
);

/** Versions of the merchant settings (MD1, PO5, MA1, MA4): append-only, the newest in force. */
export const merchantSettings = pgTable(
  'merchant_settings',
  {
    id: id(),
    perDepositUsdUnits: amountUnits('per_deposit_usd_units').notNull(),
    dailyDepositUsdUnits: amountUnits('daily_deposit_usd_units').notNull(),
    ordersPerTenMinutes: integer('orders_per_ten_minutes').notNull(),
    reapplyWaitDays: integer('reapply_wait_days').notNull(),
    infoExpiryDays: integer('info_expiry_days').notNull(),
    /** S21 BK4: a merchant's player checks an hour and a day (defaults for older versions). */
    playerChecksPerHour: integer('player_checks_per_hour').notNull().default(100),
    playerChecksPerDay: integer('player_checks_per_day').notNull().default(300),
    /** S23 OP4 (decision 12): the Diamond contact, E.164 and a Telegram username; null hides it. */
    directContactWhatsapp: text('direct_contact_whatsapp'),
    directContactTelegram: text('direct_contact_telegram'),
    /** Null for the seed. */
    adminId: uuid('admin_id'),
    createdAt: stampedAt(),
  },
  (table) => [
    index('merchant_settings_created_at_idx').on(table.createdAt.desc()),
    index('merchant_settings_admin_id_idx').on(table.adminId),
    check(
      'merchant_settings_bounds_check',
      sql`${table.perDepositUsdUnits} > 0 and ${table.perDepositUsdUnits} % 10000 = 0
        and ${table.dailyDepositUsdUnits} > 0 and ${table.dailyDepositUsdUnits} % 10000 = 0
        and ${table.dailyDepositUsdUnits} <= 100000000000
        and ${table.perDepositUsdUnits} <= ${table.dailyDepositUsdUnits}
        and ${table.ordersPerTenMinutes} between 10 and 500
        and ${table.reapplyWaitDays} between 0 and 365
        and ${table.infoExpiryDays} between 1 and 60
        and ${table.playerChecksPerHour} between 10 and 1000
        and ${table.playerChecksPerDay} between 30 and 5000`,
    ),
    check(
      'merchant_settings_direct_contact_check',
      sql`${table.directContactWhatsapp} ~ '^[+][1-9][0-9]{6,14}$'
        and ${table.directContactTelegram} ~ '^[A-Za-z0-9_]{5,32}$'`,
    ),
  ],
);

/**
 * S23 TS1: versions of a tier's privileges, append-only; the newest per tier is in force (seeded by
 * migration with TS2's values, Bronze's deposit and check values copied from the merchant settings).
 */
export const merchantTierSettings = pgTable(
  'merchant_tier_settings',
  {
    id: id(),
    tier: merchantTierEnum('tier').notNull(),
    perDepositUsdUnits: amountUnits('per_deposit_usd_units').notNull(),
    dailyDepositUsdUnits: amountUnits('daily_deposit_usd_units').notNull(),
    playerChecksPerHour: integer('player_checks_per_hour').notNull(),
    playerChecksPerDay: integer('player_checks_per_day').notNull(),
    bulkLinesMax: integer('bulk_lines_max').notNull(),
    /** TS5: the units of a code pack one order may carry. */
    orderUnitsMax: integer('order_units_max').notNull(),
    depositPriority: boolean('deposit_priority').notNull(),
    supportPriority: boolean('support_priority').notNull(),
    /** Null: no reply promise. */
    supportReplyMinutes: integer('support_reply_minutes'),
    directContact: boolean('direct_contact').notNull(),
    earlyAccess: boolean('early_access').notNull(),
    fastAlerts: boolean('fast_alerts').notNull(),
    receiptWelcome: boolean('receipt_welcome').notNull(),
    receiptLargeLogo: boolean('receipt_large_logo').notNull(),
    /** Null for the seed. */
    adminId: uuid('admin_id'),
    createdAt: stampedAt(),
  },
  (table) => [
    index('merchant_tier_settings_tier_idx').on(table.tier, table.createdAt.desc()),
    index('merchant_tier_settings_admin_id_idx').on(table.adminId),
    check(
      'merchant_tier_settings_bounds_check',
      sql`${table.perDepositUsdUnits} > 0 and ${table.perDepositUsdUnits} % 10000 = 0
        and ${table.dailyDepositUsdUnits} > 0 and ${table.dailyDepositUsdUnits} % 10000 = 0
        and ${table.dailyDepositUsdUnits} <= 100000000000
        and ${table.perDepositUsdUnits} <= ${table.dailyDepositUsdUnits}
        and ${table.playerChecksPerHour} between 10 and 1000
        and ${table.playerChecksPerDay} between 30 and 5000
        and ${table.playerChecksPerHour} <= ${table.playerChecksPerDay}
        and ${table.bulkLinesMax} between 10 and 100
        and ${table.orderUnitsMax} between 1 and 100
        and (${table.supportReplyMinutes} is null or ${table.supportReplyMinutes} between 15 and 1440)`,
    ),
  ],
);

/**
 * S23 MG1–MG7: the admin's manual tier grants; a business record closed by its end, never archived
 * or deleted (`merchant_tier_grants_guard`, migration 0105). One open grant per customer.
 */
export const merchantTierGrants = pgTable(
  'merchant_tier_grants',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    tier: merchantTierEnum('tier').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    adminId: uuid('admin_id').notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: merchantTierGrantEndReasonEnum('end_reason'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('merchant_tier_grants_open_idx')
      .on(table.customerId)
      .where(sql`${table.endedAt} is null`),
    index('merchant_tier_grants_customer_idx').on(table.customerId, table.startsAt.desc()),
    index('merchant_tier_grants_end_idx').on(table.endedAt, table.endsAt),
    index('merchant_tier_grants_admin_id_idx').on(table.adminId),
    check(
      'merchant_tier_grants_check',
      // The end is the end of a Damascus day at most 90 days ahead, so up to 91 days after the start.
      sql`${table.tier} <> 'bronze'
        and ${table.endsAt} > ${table.startsAt}
        and ${table.endsAt} <= ${table.startsAt} + interval '91 days'
        and char_length(${table.reason}) between 5 and 500
        and (${table.endedAt} is null) = (${table.endReason} is null)`,
    ),
  ],
);

/** S23 TR6: every change of a merchant's effective tier; append-only. */
export const merchantTierChanges = pgTable(
  'merchant_tier_changes',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    fromTier: merchantTierEnum('from_tier').notNull(),
    toTier: merchantTierEnum('to_tier').notNull(),
    source: merchantTierChangeSourceEnum('source').notNull(),
    createdAt: stampedAt(),
  },
  (table) => [
    index('merchant_tier_changes_created_at_idx').on(table.createdAt),
    index('merchant_tier_changes_customer_idx').on(table.customerId, table.createdAt.desc()),
    check('merchant_tier_changes_check', sql`${table.fromTier} <> ${table.toTier}`),
  ],
);

/**
 * S23 PG5: a merchant's month as it ended (net purchases, the earned and the held tier), written by
 * the monthly schedule for the month just ended; append-only.
 */
export const merchantTierMonths = pgTable(
  'merchant_tier_months',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    /** The month's first day. */
    month: date('month').notNull(),
    netPurchasesUsdUnits: amountUnits('net_purchases_usd_units').notNull(),
    earnedTier: merchantTierEnum('earned_tier').notNull(),
    heldTier: merchantTierEnum('held_tier').notNull(),
    heldSource: merchantLevelSourceEnum('held_source').notNull(),
    createdAt: stampedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.customerId, table.month] }),
    check('merchant_tier_months_check', sql`extract(day from ${table.month}) = 1`),
  ],
);
