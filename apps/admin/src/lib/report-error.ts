import { api, BACKGROUND_REQUEST } from './api/client';

/** Reports of one tab, at most: a loop of renders must not flood the API (it allows 10 a minute). */
const MAX_REPORTS = 5;
let sent = 0;

/** What the API takes of an error (`adminClientErrorSchema`): never the query of the page. */
export function clientErrorReport(error: unknown, pathname: string) {
  const failure = error instanceof Error ? error : new Error(String(error));
  return {
    name: (failure.name || 'Error').slice(0, 100),
    message: failure.message.slice(0, 500),
    ...(failure.stack && { stack: failure.stack.slice(0, 4000) }),
    path: (pathname.split(/[?#]/)[0] || '/').slice(0, 300),
  };
}

/**
 * Sends a crash of the panel to the API, which reports it to Sentry (audit A10-26): Sentry's
 * browser SDK would need its host in the CSP and may not be reachable from Syria. Never throws.
 */
export function reportClientError(error: unknown): void {
  if (sent >= MAX_REPORTS) return;
  sent += 1;
  void api
    .POST('/api/admin/client-errors', {
      body: clientErrorReport(error, window.location.pathname),
      headers: BACKGROUND_REQUEST,
    })
    .catch(() => {});
}
