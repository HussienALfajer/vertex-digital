import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { archivedAt, id, timestamps } from './columns.js';

/*
 * Customer identity, owned by the api `auth` module: the tables of the customer Better Auth
 * instance (ADR 0007). Property names are the field names Better Auth expects; column names are
 * snake_case. Better Auth generates ids through `newId` (UUIDv7). The profile fields (phone in
 * E.164, F01) and the link to the wallet (F03) arrive with their features.
 */

export const customers = pgTable('customers', {
  id: id(),
  name: text('name').notNull(),
  /** Lowercased by Better Auth. */
  email: text('email').notNull().unique(),
  /** Set once the email OTP is confirmed (F01); `@CustomerRoute()` requires it. */
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  ...timestamps(),
  archivedAt: archivedAt(),
});

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

/** Short-lived values of the customer instance (email OTP codes from F01). */
export const customerVerifications = pgTable(
  'customer_verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [index('customer_verifications_identifier_idx').on(table.identifier)],
);
