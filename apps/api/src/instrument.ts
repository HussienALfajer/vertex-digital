/*
 * Sentry, loaded before anything else (`main.ts` imports this first) so it can instrument the
 * modules that follow. Off when SENTRY_DSN is empty (development, tests). Events never carry
 * cookies, authorization headers, ALTCHA payloads, the Telegram webhook secret, request bodies or
 * the values of private query parameters such as the panel's searches (ADR 0008).
 */
import * as Sentry from '@sentry/nestjs';
import { loadRootEnv } from '@vertex-digital/db';
import { SECRET_HEADERS, withoutPrivateQuery } from './core/http/secret-headers.js';

loadRootEnv();

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        for (const header of SECRET_HEADERS) delete event.request.headers?.[header];
        const { url, query_string: query, headers } = event.request;
        if (url) event.request.url = withoutPrivateQuery(url);
        if (typeof query === 'string')
          event.request.query_string = withoutPrivateQuery(`?${query}`).slice(1);
        else delete event.request.query_string;
        if (headers?.referer) headers.referer = withoutPrivateQuery(headers.referer);
      }
      return event;
    },
  });
}
