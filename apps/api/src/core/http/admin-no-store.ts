import type { IncomingMessage, ServerResponse } from 'node:http';

const ADMIN_PREFIX = '/api/admin';

/**
 * Admin answers hold private data (audit details with addresses, sessions, customers, money): by
 * default no browser or proxy keeps a copy, so a shared computer's cache never shows them later.
 * A route that sets its own `Cache-Control` (a thumbnail, a served image) replaces this one.
 */
export function adminNoStore(request: IncomingMessage, response: ServerResponse, next: () => void) {
  // Express matches routes case-insensitively, so `/API/Admin/...` reaches an admin route too.
  const path = (request.url ?? '/').split('?')[0]?.toLowerCase() ?? '/';
  if (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)) {
    response.setHeader('cache-control', 'no-store');
  }
  next();
}
