/**
 * Request headers that carry a credential: never in the logs or Sentry (ADR 0008). The session
 * cookie, authorization, the ALTCHA payload, and the Telegram webhook's secret (S05 rule TG4).
 * No imports, so `instrument.ts` can load it before Sentry instruments the modules that follow.
 */
export const SECRET_HEADERS = [
  'cookie',
  'authorization',
  'x-altcha',
  'x-telegram-bot-api-secret-token',
] as const;

/** The pino `redact` paths: the secret headers of each request, and the session cookies set. */
export const LOG_REDACT_PATHS = [
  ...SECRET_HEADERS.map((header) => `req.headers["${header}"]`),
  'res.headers["set-cookie"]',
];

/**
 * Query parameters that carry personal data: the panel's searches (`q`, a name, an email or a
 * phone number). Their values never reach the logs or Sentry (ADR 0008, audit A5).
 */
export const PRIVATE_QUERY_PARAMS = ['q'] as const;

/** `url` (a path or a full URL) with the values of the private query parameters replaced. */
export function withoutPrivateQuery(url: string): string {
  const mark = url.indexOf('?');
  if (mark === -1) return url;
  const params = new URLSearchParams(url.slice(mark + 1));
  const found = PRIVATE_QUERY_PARAMS.filter((name) => params.has(name));
  if (found.length === 0) return url;
  for (const name of found) params.set(name, 'REDACTED');
  return `${url.slice(0, mark)}?${params}`;
}

interface LoggedRequest {
  url?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

/**
 * The pino serializers: the request as pino-http serializes it, with the private query
 * parameters taken out of its URL, its parsed query and its `Referer` (the panel keeps a search
 * in its own address, which the browser sends with each API call).
 */
export const LOG_SERIALIZERS = {
  req: (req: LoggedRequest): LoggedRequest => {
    const referer = req.headers?.referer;
    const query = req.query && { ...req.query };
    for (const name of PRIVATE_QUERY_PARAMS) if (query && name in query) query[name] = 'REDACTED';
    return {
      ...req,
      ...(req.url !== undefined && { url: withoutPrivateQuery(req.url) }),
      ...(query && { query }),
      ...(req.headers && {
        headers: {
          ...req.headers,
          ...(typeof referer === 'string' && { referer: withoutPrivateQuery(referer) }),
        },
      }),
    };
  },
};
