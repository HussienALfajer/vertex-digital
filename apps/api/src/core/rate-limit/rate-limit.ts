import type { ExecutionContext } from '@nestjs/common';
import { Throttle, type ThrottlerModuleOptions } from '@nestjs/throttler';

/*
 * API rate limits per client IP (ADR 0008), on top of nginx's. Counters live in memory: the API
 * runs as one process (ADR 0009). Limits that must survive a restart (OTP sends, deposits) keep
 * their counters in PostgreSQL, with their features. A refused request answers `429 RATE_LIMITED`.
 */

/** Every route: generous, to stop runaway clients without touching normal use. */
export const DEFAULT_RATE_LIMIT = { limit: 300, perSeconds: 60 } as const;

/** The header the store's server sends on its cached public reads (`apps/store/src/lib/server-env.ts`). */
export const STORE_CACHE_READ_HEADER = 'x-store-cache-read';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

interface ThrottledRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

/**
 * A cached read by the store's server: a GET marked with the header, from this machine, with no
 * `X-Forwarded-For`. nginx sets that header on every request it passes on, so nothing from outside
 * can look like one. These reads carry no visitor address (one cached answer serves every
 * visitor), so they would all share the loopback address's counter, and a stream of made-up game
 * slugs would exhaust it for every page (audit A10-36). nginx's zones still count the visitors.
 */
export function isStoreCacheRead(request: ThrottledRequest): boolean {
  return (
    request.method === 'GET' &&
    request.headers[STORE_CACHE_READ_HEADER] === '1' &&
    request.headers['x-forwarded-for'] === undefined &&
    LOOPBACK.has(request.socket.remoteAddress ?? '')
  );
}

export const throttlerOptions: ThrottlerModuleOptions = {
  throttlers: [
    { name: 'default', limit: DEFAULT_RATE_LIMIT.limit, ttl: DEFAULT_RATE_LIMIT.perSeconds * 1000 },
  ],
  skipIf: (context: ExecutionContext) =>
    context.getType() === 'http' && isStoreCacheRead(context.switchToHttp().getRequest()),
};

/** A tighter limit for one route (or controller), per client IP. */
export const RateLimit = ({ limit, perSeconds }: { limit: number; perSeconds: number }) =>
  Throttle({ default: { limit, ttl: perSeconds * 1000 } });
