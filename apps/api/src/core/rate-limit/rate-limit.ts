import { Throttle, type ThrottlerModuleOptions } from '@nestjs/throttler';

/*
 * API rate limits per client IP (ADR 0008), on top of nginx's. Counters live in memory: the API
 * runs as one process (ADR 0009). Limits that must survive a restart (OTP sends, deposits) keep
 * their counters in PostgreSQL, with their features. A refused request answers `429 RATE_LIMITED`.
 */

/** Every route: generous, to stop runaway clients without touching normal use. */
export const DEFAULT_RATE_LIMIT = { limit: 300, perSeconds: 60 } as const;

export const throttlerOptions: ThrottlerModuleOptions = {
  throttlers: [
    { name: 'default', limit: DEFAULT_RATE_LIMIT.limit, ttl: DEFAULT_RATE_LIMIT.perSeconds * 1000 },
  ],
};

/** A tighter limit for one route (or controller), per client IP. */
export const RateLimit = ({ limit, perSeconds }: { limit: number; perSeconds: number }) =>
  Throttle({ default: { limit, ttl: perSeconds * 1000 } });
