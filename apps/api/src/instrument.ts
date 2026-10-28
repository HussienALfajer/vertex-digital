/*
 * Sentry, loaded before anything else (`main.ts` imports this first) so it can instrument the
 * modules that follow. Off when SENTRY_DSN is empty (development, tests). Events never carry
 * cookies, authorization headers, ALTCHA payloads, the Telegram webhook secret, request bodies or
 * the values of private query parameters such as the panel's searches (ADR 0008).
 */
import * as Sentry from '@sentry/nestjs';
import { loadRootEnv } from '@vertex-digital/db';
import { scrubEvent } from './core/http/secret-headers.js';

loadRootEnv();

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    beforeSend: scrubEvent,
  });
}
