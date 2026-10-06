import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ErrorResponse } from '@vertex-digital/contracts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ADMIN_PREFIX = '/api/admin';

/**
 * CSRF and host separation (ADR 0007, 0008), on every route, Better Auth's included:
 * - `/api/admin/*` refuses any browser request that does not come from the admin origin, reads
 *   included, so a page on the store (or anywhere else) can never drive the panel's API;
 * - other routes refuse state changes a browser marks as coming from an origin other than the
 *   store's, even a sibling subdomain that `SameSite` cookies would let through.
 * Requests without these browser headers (servers, scripts, tests, supplier webhooks) carry no
 * ambient cookie risk and pass.
 */
export function sameOriginOnly(origins: { store: string; admin: string }) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    // Express matches routes case-insensitively, so `/API/Admin/...` reaches a staff route too.
    const path = (request.url ?? '/').split('?')[0]?.toLowerCase() ?? '/';
    const admin = path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);
    if (admin || !SAFE_METHODS.has(request.method ?? 'GET')) {
      const allowed = admin ? origins.admin : origins.store;
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      const foreign =
        origin !== undefined
          ? origin !== allowed
          : site !== undefined && site !== 'same-origin' && site !== 'none';
      if (foreign) {
        const body: ErrorResponse = {
          statusCode: 403,
          code: 'CROSS_ORIGIN_REFUSED',
          message: 'Cross-origin requests are refused',
        };
        response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
        return;
      }
    }
    next();
  };
}
