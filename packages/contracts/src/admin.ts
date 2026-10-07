import { z } from 'zod';

/*
 * The one admin account (ADR 0016), owned by the api `admin` module. There are no roles or
 * permissions: the account has full access, guarded by TOTP, short sessions and re-authentication.
 */

/** One of the admin's own sessions (`GET /api/admin/me/sessions`). */
export const adminSessionSchema = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    lastActiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    /** The session of the request itself. */
    current: z.boolean(),
  })
  .meta({ id: 'AdminSession' });

export type AdminSession = z.infer<typeof adminSessionSchema>;

export const adminSessionListSchema = z.array(adminSessionSchema).meta({ id: 'AdminSessionList' });

/** The admin session rules (rules D4, D5). */
export const ADMIN_SESSION_RULES = {
  /** Without a request the user made, the session ends after this long. */
  idleTimeoutMs: 30 * 60 * 1000,
  /** The session ends this long after sign-in, whatever the activity. */
  absoluteLifetimeMs: 12 * 60 * 60 * 1000,
  /** A re-authentication opens sensitive routes for this long. */
  reauthenticationMs: 5 * 60 * 1000,
} as const;

/**
 * The header the panel sets on requests it makes on its own (polling, refetch on focus): they do
 * not count as activity for the idle timeout (rule D4).
 */
export const BACKGROUND_REQUEST_HEADER = 'x-background-request';
