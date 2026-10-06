/*
 * Sentry, loaded before anything else (`main.ts` imports this first). Off when SENTRY_DSN is
 * empty (development, tests). Job payloads are never attached to events, and the Telegram token
 * is removed from request breadcrumbs (ADR 0008).
 */
import * as Sentry from '@sentry/nestjs';
import { loadRootEnv } from '@vertex-digital/db';
import { scrubBreadcrumb } from './core/alerts/scrub-breadcrumb.js';

loadRootEnv();

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
