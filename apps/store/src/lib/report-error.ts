import { randomUUID } from 'node:crypto';

/*
 * The store server's errors to Sentry (ADR 0002, audit A10-18), with the envelope endpoint the
 * SDKs post to: no SDK in the store, so nothing reaches a browser bundle or the first-load
 * budgets. Server code only (`instrumentation.ts`); off without `SENTRY_DSN`. An event carries the
 * error and the route's pattern (`/g/[token]`): never the path, a header, a cookie or a body
 * (ADR 0008).
 */

export interface ReportedRequest {
  path: string;
  method: string;
}

export interface ReportedContext {
  routePath: string;
  routeType: string;
}

/** The envelope for `error`, or null when the DSN is not one. */
export function sentryEnvelope(
  dsn: string,
  error: unknown,
  request: ReportedRequest,
  context: ReportedContext,
  now = new Date(),
): { url: string; auth: string; body: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return null;
  }
  const project = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!parsed.username || !project) return null;
  const failure = error instanceof Error ? error : new Error(String(error));
  const eventId = randomUUID().replaceAll('-', '');
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: 'node',
    level: 'error',
    logger: 'store',
    environment: process.env.NODE_ENV,
    server_name: 'store',
    exception: { values: [{ type: failure.name, value: failure.message }] },
    tags: { route: context.routePath, route_type: context.routeType },
    // The route's pattern, never the path: `/g/<token>`, `/r/<token>`, `/v/<code>` carry a
    // working link (audit A10-18, as nginx's `vdprivacy` log).
    request: { method: request.method, url: context.routePath },
    extra: { stack: failure.stack?.split('\n').slice(0, 20).join('\n') },
  };
  return {
    url: `${parsed.protocol}//${parsed.host}/api/${project}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_key=${parsed.username}, sentry_client=vertex-store/1`,
    body: [
      JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n'),
  };
}

/** Sends `error` to Sentry, in at most 5 seconds; never throws. */
export async function reportError(
  error: unknown,
  request: ReportedRequest,
  context: ReportedContext,
): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  const envelope = sentryEnvelope(dsn, error, request, context);
  if (!envelope) return;
  await fetch(envelope.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': envelope.auth },
    body: envelope.body,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}
