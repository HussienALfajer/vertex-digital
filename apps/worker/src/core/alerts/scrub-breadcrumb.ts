import type { Breadcrumb } from '@sentry/nestjs';

/** The Bot API puts the token in the path (`/bot<token>/sendMessage`). */
const BOT_TOKEN_PATH = /\/bot[^/\s]+\//g;

/** An http(s) URL: its origin (any user info dropped), then its path, query and fragment. */
const URL_PATTERN = /(https?:\/\/)(?:[^/\s@]*@)?([^/\s?#]+)([^\s"'<>]*)/g;

/** Request fields Sentry records apart from the URL; a provider's key can sit in the query. */
const DROPPED_FIELDS = ['http.query', 'http.fragment'];

/**
 * Keeps a URL's origin, and its path only when it is the Bot API's with the token removed. Every
 * other path and every query goes: BSC providers put their key in the path (NodeReal
 * `/v1/<key>`), others in the query, and user info is a password (audit A2).
 */
function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (_match, scheme: string, host: string, rest: string) => {
    const path = rest.replace(BOT_TOKEN_PATH, '/bot[redacted]/').replace(/[?#].*$/, '');
    const kept = path.startsWith('/bot[redacted]/') ? path : rest ? '/[redacted]' : '';
    return `${scheme}${host}${kept}`;
  });
}

/**
 * Sentry records a breadcrumb for every outgoing request, URL included, and ships it with the
 * next event: secrets in URLs are removed from it first (ADR 0008): the Telegram token, and the
 * chain readers' provider keys (audit A2). No other import here, so `instrument.ts` can load it
 * before Sentry instruments the modules that follow.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.message) breadcrumb.message = redactUrls(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const field of DROPPED_FIELDS) delete data[field];
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') data[key] = redactUrls(value);
    }
  }
  return breadcrumb;
}
