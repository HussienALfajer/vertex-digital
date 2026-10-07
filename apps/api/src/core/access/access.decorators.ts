import { SetMetadata } from '@nestjs/common';

/*
 * Who may call a route (ADR 0011, 0016). Every route carries exactly one of these; the
 * architecture test fails on a route without. They are metadata only: `AccessGuard` enforces them.
 */

export const ACCESS = Symbol('ACCESS');

export type RouteAccess = { kind: 'public' } | { kind: 'customer' } | { kind: 'admin' };

/** Anyone, signed in or not. Pair state-changing public routes with `@RateLimit`. */
export const Public = () => SetMetadata(ACCESS, { kind: 'public' } satisfies RouteAccess);

/** A signed-in customer whose email is verified (ADR 0007). Never under `/api/admin/`. */
export const CustomerRoute = () => SetMetadata(ACCESS, { kind: 'customer' } satisfies RouteAccess);

/**
 * The signed-in admin with TOTP enrolled (ADR 0007, 0016). There are no roles or permissions: the
 * one admin account has full access. Only under `/api/admin/`.
 */
export const AdminRoute = () => SetMetadata(ACCESS, { kind: 'admin' } satisfies RouteAccess);
