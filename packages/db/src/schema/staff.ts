import { STAFF_ROLES } from '@vertex-digital/contracts';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, id, timestamps } from './columns.js';

/*
 * Staff identity, owned by the api `staff` module: the tables of the staff Better Auth instance
 * (ADR 0007), separate from the customers' so a customer session can never act on the panel.
 * Property names are the field names Better Auth expects; column names are snake_case.
 */

export const staffRoleEnum = pgEnum('staff_role', STAFF_ROLES);

export const staffUsers = pgTable('staff_users', {
  id: id(),
  name: text('name').notNull(),
  /** Lowercased by Better Auth. */
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Set by the Better Auth two-factor plugin once TOTP is verified; staff routes require it. */
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  role: staffRoleEnum('role').notNull(),
  ...timestamps(),
  archivedAt: archivedAt(),
});

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps(),
  },
  (table) => [index('staff_sessions_user_id_idx').on(table.userId)],
);

/** Sign-in methods of a staff member: the `credential` provider (email and password) only. */
export const staffAccounts = pgTable(
  'staff_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Better Auth's password hash; never selected outside the staff module. */
    password: text('password'),
    ...timestamps(),
  },
  (table) => [index('staff_accounts_user_id_idx').on(table.userId)],
);

/** Short-lived values of the staff instance (the two-factor step between password and TOTP). */
export const staffVerifications = pgTable(
  'staff_verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [index('staff_verifications_identifier_idx').on(table.identifier)],
);

/** TOTP secret and backup codes, both encrypted by the Better Auth two-factor plugin. */
export const staffTwoFactors = pgTable(
  'staff_two_factors',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('staff_two_factors_user_id_idx').on(table.userId)],
);
