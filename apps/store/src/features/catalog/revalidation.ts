import { createHash, timingSafeEqual } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Next.js fills `X-Forwarded-For` with the socket's address when no proxy set it. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Equal secrets, compared in constant time (hashes first, so lengths never leak). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Rule SF4: a call to the revalidation route straight from this machine (a loopback `Host` and
 * address, no proxy's headers) with `Authorization: Bearer <STORE_REVALIDATE_SECRET>`. nginx sets
 * the public `Host`, `X-Real-IP` and the client's `X-Forwarded-For` on everything it proxies, so a
 * request from outside never passes.
 */
export function authorizedRevalidation(headers: Headers, secret: string): boolean {
  if (headers.has('x-real-ip') || headers.has('forwarded')) return false;
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor !== null && !LOOPBACK_ADDRESSES.has(forwardedFor.trim())) return false;
  const host = (headers.get('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return false;
  const authorization = headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return false;
  return sameSecret(authorization.slice('Bearer '.length), secret);
}
