import { APIError } from 'better-auth/api';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';

/*
 * Helpers of the auth module's own Better Auth endpoints (`auth.config.ts`, `passkeys.plugin.ts`).
 */

/** The address and the browser of a Better Auth request. */
export const metaOf = (headers: Headers | undefined): RequestMeta => ({
  // nginx overwrites X-Forwarded-For with the client address (ADR 0009).
  ipAddress: headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
  userAgent: headers?.get('user-agent')?.slice(0, 500) ?? null,
});

const STATUSES = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'TOO_MANY_REQUESTS',
} as const;

/** A coded error of the auth module, answered by Better Auth with its code (the store translates it). */
export const toApiError = (error: unknown): unknown =>
  error instanceof CodedException
    ? new APIError(STATUSES[error.getStatus() as keyof typeof STATUSES] ?? 'BAD_REQUEST', {
        code: error.code,
        message: error.message,
      })
    : error;
