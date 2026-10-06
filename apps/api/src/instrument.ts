/*
 * Sentry, loaded before anything else (`main.ts` imports this first) so it can instrument the
 * modules that follow. Off when SENTRY_DSN is empty (development, tests). Events never carry
 * cookies, authorization headers, ALTCHA payloads or request bodies (ADR 0008).
 */
import * as Sentry from '@sentry/nestjs';
import { loadRootEnv } from '@vertex-digital/db';

loadRootEnv();

const SECRET_HEADERS = ['cookie', 'authorization', 'x-altcha'];

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        for (const header of SECRET_HEADERS) delete event.request.headers?.[header];
      }
      return event;
    },
  });
}
