import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@vertex-digital/contracts';

/*
 * Who may call a route (ADR 0011). Every route carries exactly one of these; the architecture
 * test fails on a route without. They are metadata only: `AccessGuard` enforces them.
 */

export const ACCESS = Symbol('ACCESS');

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'customer' }
  | { kind: 'staff'; permissions: Permission[] };

/** Anyone, signed in or not. Pair state-changing public routes with `@RateLimit`. */
export const Public = () => SetMetadata(ACCESS, { kind: 'public' } satisfies RouteAccess);

/** A signed-in customer whose email is verified (ADR 0007). Never under `/api/admin/`. */
export const CustomerRoute = () => SetMetadata(ACCESS, { kind: 'customer' } satisfies RouteAccess);

/**
 * A signed-in staff member with TOTP enrolled who holds every listed permission (ADR 0007); with
 * none listed, any staff member. Only under `/api/admin/`.
 */
export const StaffRoute = (...permissions: Permission[]) =>
  SetMetadata(ACCESS, { kind: 'staff', permissions } satisfies RouteAccess);
