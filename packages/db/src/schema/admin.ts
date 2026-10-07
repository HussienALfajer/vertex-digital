import { sql } from 'drizzle-orm';
import {
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
 * The admin account, owned by the api `admin` module: the tables of the admin Better Auth
 * instance (ADR 0007, 0016), separate from the customers' so a customer session can never act on
 * the panel. Property names are the field names Better Auth expects; column names are snake_case.
 */

/** At most one row (ADR 0016): the unique index on a constant makes a second admin impossible. */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: id(),
    name: text('name').notNull(),
    /** Lowercased by Better Auth. */
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /** Set by the Better Auth two-factor plugin once TOTP is verified; admin routes require it. */
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    /** Set by the CLI with a printed password; cleared by the admin's own change (rule D1). */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    ...timestamps(),
    /** Kept for the Better Auth hook; never set in V1 (ADR 0016). */
    archivedAt: archivedAt(),
  },
  () => [uniqueIndex('admin_users_single_idx').using('btree', sql`(true)`)],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** The last request the admin made (rule D4); updated at most once a minute. */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    /** The last re-authentication on this session (rule D5). */
    reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('admin_sessions_user_id_idx').on(table.userId)],
);

/** Sign-in methods of the admin: the `credential` provider (email and password) only. */
export const adminAccounts = pgTable(
  'admin_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Better Auth's password hash; never selected outside the admin module. */
    password: text('password'),
    ...timestamps(),
  },
  (table) => [index('admin_accounts_user_id_idx').on(table.userId)],
);

/** Short-lived values of the admin instance (the two-factor step between password and TOTP). */
export const adminVerifications = pgTable(
  'admin_verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [index('admin_verifications_identifier_idx').on(table.identifier)],
);

/** TOTP secret and backup codes, both encrypted by the Better Auth two-factor plugin. */
export const adminTwoFactors = pgTable(
  'admin_two_factors',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('admin_two_factors_user_id_idx').on(table.userId)],
);
