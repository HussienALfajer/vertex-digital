import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, id, timestamps } from './columns.js';

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
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [index('customers_phone_idx').on(table.phone)],
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
 * Short-lived values of the customer instance: email codes. One per identifier (`<purpose>-otp-<email>`),
 * so a new code always replaces the previous one of the same purpose (rule C4).
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
