import type { Breadcrumb } from '@sentry/nestjs';

/** The Bot API puts the token in the path (`/bot<token>/sendMessage`). */
const BOT_TOKEN_PATH = /\/bot[^/]+\//g;

/**
 * Sentry records a breadcrumb for every outgoing request, URL included, and ships it with the
 * next event: the Telegram token is removed from it first (ADR 0008). No other import here, so
 * `instrument.ts` can load it before Sentry instruments the modules that follow.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const redact = (text: string) => text.replace(BOT_TOKEN_PATH, '/bot[redacted]/');
  if (breadcrumb.message) breadcrumb.message = redact(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') data[key] = redact(value);
    }
  }
  return breadcrumb;
}
