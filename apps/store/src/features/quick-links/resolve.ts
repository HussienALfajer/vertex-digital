import type { QuickLinkResolve } from '@vertex-digital/contracts';
import { API_READ_TIMEOUT_MS, apiInternalUrl } from '@/lib/server-env';
import type { QuickLinkOpen } from './handoff';

/*
 * `/q/<code>` (S22 DL1, DL2), resolved by the store's server on every request: the API counts one
 * open per visitor, code and hour, so the visitor's address goes with the call (nginx overwrites
 * `X-Forwarded-For` before the store; the API trusts it from loopback only, ADR 0009). The target
 * is always a path of this store, built here from the API's slug and id, never a URL.
 */

const CODE = /^[2-9A-HJKMNP-Za-hjkmnp-z]{6}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CAMPAIGN = /^[a-z0-9_-]{1,32}$/;

export interface QuickLinkTarget {
  path: string;
  /** Set for a pack: what the game page keeps for the order (DL4). */
  open: QuickLinkOpen | null;
}

export async function resolveQuickLink(
  code: string,
  campaign: string | null,
  visitor: string | null,
): Promise<QuickLinkTarget> {
  const home = { path: '/', open: null };
  if (!CODE.test(code)) return home;
  const tag = campaign && CAMPAIGN.test(campaign) ? campaign : null;
  const query = tag ? `?${new URLSearchParams({ c: tag })}` : '';
  let resolved: QuickLinkResolve;
  try {
    const response = await fetch(`${apiInternalUrl()}/api/q/${code.toUpperCase()}${query}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(API_READ_TIMEOUT_MS),
      headers: { accept: 'application/json', ...(visitor && { 'x-forwarded-for': visitor }) },
    });
    if (!response.ok) return home;
    resolved = (await response.json()) as QuickLinkResolve;
  } catch {
    return home;
  }
  if (resolved.target === 'home' || !SLUG.test(resolved.gameSlug)) return home;
  if (resolved.target === 'game') return { path: `/games/${resolved.gameSlug}`, open: null };
  return {
    path: `/games/${resolved.gameSlug}?${new URLSearchParams({ pack: resolved.productId, via: 'q' })}`,
    open: { code: code.toUpperCase(), productId: resolved.productId, campaign: tag },
  };
}
