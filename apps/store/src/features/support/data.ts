import { type SupportChannels, telegramSupportUrlSchema } from '@vertex-digital/contracts';
import { cacheLife, cacheTag } from 'next/cache';
import { connection } from 'next/server';
import { SUPPORT_TAG } from '@/lib/cache-tags';
import { API_READ_TIMEOUT_MS, apiInternalUrl, CACHED_READ_HEADERS } from '@/lib/server-env';

/*
 * The support channels as the store's server components read them (S12 SC2): the API's public
 * route, which reads no cookie, cached under the `support` tag for the route's own 60 seconds. A
 * failed read is never cached.
 */

/** SC2: the route answers `public, max-age=60`; a stale link is served while it is read again. */
const SUPPORT_LIFE = { stale: 60, revalidate: 60, expire: 24 * 60 * 60 };

class ChannelsUnavailable extends Error {}

/** `GET /api/support/channels`. */
export async function getSupportChannels(): Promise<SupportChannels> {
  'use cache';
  cacheTag(SUPPORT_TAG);
  cacheLife(SUPPORT_LIFE);
  const response = await fetch(`${apiInternalUrl()}/api/support/channels`, {
    headers: CACHED_READ_HEADERS,
    signal: AbortSignal.timeout(API_READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ChannelsUnavailable(`GET /api/support/channels answered ${response.status}`);
  }
  return (await response.json()) as SupportChannels;
}

/**
 * The Telegram link at request time, never during the build; null when none is set or the read
 * failed: a missing link must not break the page that shows it (the footer is on every page).
 */
export async function telegramSupportUrl(): Promise<string | null> {
  await connection();
  try {
    const { telegramUrl } = await getSupportChannels();
    // Only a Telegram link (SC1), whatever the answer holds.
    return telegramUrl && telegramSupportUrlSchema.safeParse(telegramUrl).success
      ? telegramUrl
      : null;
  } catch {
    return null;
  }
}
