import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Prefixes whose answers hold private data: the admin's (audit details with addresses, sessions,
 * customers, money) and the customer's own account (`/api/auth`: the session and its device list;
 * `/api/account`: the profile). Feature 1 (F1-1) covered the admin's; the feature 2 audit
 * (2026-10-15) added the customer's.
 */
const PRIVATE_PREFIXES = ['/api/admin', '/api/auth', '/api/account'];

/**
 * By default no browser or proxy keeps a copy of a private answer, so a shared computer's cache
 * never shows it later. A route that sets its own `Cache-Control` (a thumbnail, a served image)
 * replaces this one.
 */
export function privateNoStore(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  // Express matches routes case-insensitively, so `/API/Admin/...` reaches an admin route too.
  const path = (request.url ?? '/').split('?')[0]?.toLowerCase() ?? '/';
  if (PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    response.setHeader('cache-control', 'no-store');
  }
  next();
}
