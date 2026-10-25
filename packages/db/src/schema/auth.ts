import { ACCOUNT_TYPES, PASSKEY_DEVICE_TYPES } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { archivedAt, id, timestamps } from './columns.js';
import { contentPageVersions } from './content.js';
import { priceLists } from './price-lists.js';

export const accountTypeEnum = pgEnum('account_type', ACCOUNT_TYPES);

/*
 * Customer identity, owned by the api `auth` module: the tables of the customer Better Auth
 * instance (ADR 0007). Property names are the field names Better Auth expects; column names are
 * snake_case. Better Auth generates ids through `newId` (UUIDv7). The link to the wallet arrives
 * with F03 (S02).
 */

export const customers = pgTable(
  'customers',
  {
    id: id(),
    name: text('name').notNull(),
    /** Lowercased by Better Auth. */
    email: text('email').notNull().unique(),
    /** Set once the email OTP is confirmed (S01 rule C7); `@CustomerRoute()` requires it. */
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /** E.164, from `phoneSchema`. Not unique (rule C6): shared numbers are a fraud signal (F19). */
    phone: text('phone').notNull(),
    /** Created by the admin for testing (rule T1); reports and dashboards leave it out. */
    isTest: boolean('is_test').notNull().default(false),
    /** S12 CF1: set while the admin keeps the customer from depositing and buying. */
    frozenAt: timestamp('frozen_at', { withTimezone: true }),
    /** S14 TA2: the terms and privacy versions in force at sign-up; null before publication. */
    termsVersionId: uuid('terms_version_id').references(() => contentPageVersions.id),
    privacyVersionId: uuid('privacy_version_id').references(() => contentPageVersions.id),
    /** S20 AT1: written only by the `merchants` and `pricing` admin paths, customer locked. */
    accountType: accountTypeEnum('account_type').notNull().default('customer'),
    /** S20 AT1: an assigned list; null is the type's default (`effectivePriceListId`). */
    priceListId: uuid('price_list_id').references(() => priceLists.id),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('customers_phone_idx').on(table.phone),
    index('customers_terms_version_id_idx').on(table.termsVersionId),
    index('customers_privacy_version_id_idx').on(table.privacyVersionId),
    index('customers_price_list_id_idx').on(table.priceListId),
  ],
);

/**
 * S12: every session created for a customer (sign-in, verification, password reset), for the
 * devices tab and the shared-IP signal (CS5). Kept 90 days, then deleted by the worker.
 */
export const customerSignIns = pgTable(
  'customer_sign_ins',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customer_sign_ins_customer_idx').on(table.customerId, table.createdAt.desc()),
    index('customer_sign_ins_ip_idx').on(table.ipAddress, table.createdAt.desc()),
    check(
      'customer_sign_ins_user_agent_check',
      sql`${table.userAgent} is null or char_length(${table.userAgent}) <= 500`,
    ),
  ],
);

export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps(),
  },
  (table) => [index('customer_sessions_user_id_idx').on(table.userId)],
);

/** Sign-in methods of a customer. Email and password sign-in is the `credential` provider. */
export const customerAccounts = pgTable(
  'customer_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Better Auth's password hash; never selected outside the auth module. */
    password: text('password'),
    ...timestamps(),
  },
  (table) => [index('customer_accounts_user_id_idx').on(table.userId)],
);

/**
 * S22 PK1–PK6 (ADR 0037): the customer's passkeys, written only by the auth module's passkey
 * endpoints and account routes. Credentials, not business records: a removal or a password reset
 * deletes the row, and its audit entry keeps the id and name. `public_key` is the COSE key in
 * base64; `counter` the authenticator's signature counter, which must only go up (PK3).
 */
export const customerPasskeys = pgTable(
  'customer_passkeys',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    /** The WebAuthn credential id, base64url. */
    credentialId: text('credential_id').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull(),
    deviceType: text('device_type', { enum: PASSKEY_DEVICE_TYPES }).notNull(),
    backedUp: boolean('backed_up').notNull(),
    /** The authenticator's transports, comma-separated (`internal,hybrid`). */
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('customer_passkeys_credential_id_idx').on(table.credentialId),
    index('customer_passkeys_customer_idx').on(table.customerId, table.createdAt),
    check(
      'customer_passkeys_name_check',
      sql`char_length(${table.name}) between 1 and 40 and ${table.name} = btrim(${table.name})`,
    ),
    check(
      'customer_passkeys_device_type_check',
      sql`${table.deviceType} in ('singleDevice', 'multiDevice')`,
    ),
    check('customer_passkeys_counter_check', sql`${table.counter} >= 0`),
  ],
);

/**
 * Short-lived values of the customer instance: email codes. One per identifier (`<purpose>-otp-<email>`),
 * so a new code always replaces the previous one of the same purpose (rule C4). S22: WebAuthn
 * challenges (a random identifier in a signed cookie, single use) and the passkey registration
 * grant of a session (`passkey-grant:<session id>`, rule PK2).
 */
export const customerVerifications = pgTable(
  'customer_verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [uniqueIndex('customer_verifications_identifier_idx').on(table.identifier)],
);

/**
 * Rate-limit counters of the customer instance (ADR 0008, rule C5), in PostgreSQL so they survive
 * a restart: Better Auth's per-address limits, and the auth module's per-email code limits.
 * `last_request` is a time in milliseconds since the epoch, as Better Auth stores it.
 */
export const customerRateLimits = pgTable('customer_rate_limits', {
  id: id(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
