import { SetMetadata } from '@nestjs/common';
import { ADMIN_SESSION_RULES } from '@vertex-digital/contracts';

/*
 * Who may call a route (ADR 0011, 0016). Every route carries exactly one of these; the
 * architecture test fails on a route without. They are metadata only: `AccessGuard` enforces them.
 */

export const ACCESS = Symbol('ACCESS');
export const SENSITIVE = Symbol('SENSITIVE');

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'customer' }
  | { kind: 'admin' }
  | { kind: 'adminSetup' };

/** Anyone, signed in or not. Pair state-changing public routes with `@RateLimit`. */
export const Public = () => SetMetadata(ACCESS, { kind: 'public' } satisfies RouteAccess);

/** A signed-in customer whose email is verified (ADR 0007). Never under `/api/admin/`. */
export const CustomerRoute = () => SetMetadata(ACCESS, { kind: 'customer' } satisfies RouteAccess);

/**
 * The signed-in admin, TOTP enrolled and no pending password change (ADR 0007, 0016, S01 rule
 * D1). There are no roles or permissions: the one admin account has full access. Only under
 * `/api/admin/`.
 */
export const AdminRoute = () => SetMetadata(ACCESS, { kind: 'admin' } satisfies RouteAccess);

/**
 * The signed-in admin before the account is set up: the forced change of a CLI-issued password
 * (rule D1). Idle expiry still applies. Only under `/api/admin/`.
 */
export const AdminSetupRoute = () =>
  SetMetadata(ACCESS, { kind: 'adminSetup' } satisfies RouteAccess);

/**
 * An admin action that needs a re-authentication (password and TOTP) within the last 5 minutes,
 * else `403 REAUTHENTICATION_REQUIRED` (rule D5). Each spec marks its own sensitive routes.
 */
export const Sensitive = () => SetMetadata(SENSITIVE, true);

/**
 * True when the admin re-authenticated in the last 5 minutes (rule D5): what `@Sensitive()`
 * checks, for a route whose need for it depends on the request (S03 rule RV4).
 */
export function isRecentlyReauthenticated(
  admin: { reauthenticatedAt: Date | null },
  now = Date.now(),
): boolean {
  return (
    admin.reauthenticatedAt !== null &&
    now - admin.reauthenticatedAt.getTime() <= ADMIN_SESSION_RULES.reauthenticationMs
  );
}
