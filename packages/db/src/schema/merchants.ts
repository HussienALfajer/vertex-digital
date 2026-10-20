import {
  GOVERNORATES,
  HEARD_FROM,
  MERCHANT_ACTIVITIES,
  MERCHANT_APPLICATION_EVENTS,
  MERCHANT_APPLICATION_STATUSES,
  MONTHLY_VOLUMES,
  PRODUCT_INTERESTS,
  SALES_CHANNELS,
  YEARS_IN_BUSINESS,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { amountUnits, id, timestamps } from './columns.js';
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
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('merchant_profiles_application_id_idx').on(table.applicationId),
    index('merchant_profiles_terms_version_id_idx').on(table.termsVersionId),
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
        and ${table.infoExpiryDays} between 1 and 60`,
    ),
  ],
);
