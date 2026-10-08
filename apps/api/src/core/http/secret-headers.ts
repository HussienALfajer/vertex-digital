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
