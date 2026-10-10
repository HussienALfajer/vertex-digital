import type { PublicShare, ShareKind } from '@vertex-digital/contracts';
import { headers } from 'next/headers';
import { apiInternalUrl } from '@/lib/server-env';

/*
 * The public gift and receipt (S10 rules SH1, SH6), read by the store's server on every request
 * and never cached here: a revocation must take effect within the API's 30 seconds. The API
 * limits reads per visitor (SH5), so the visitor's address goes with the call: nginx overwrites
 * `X-Forwarded-For` with it before the store, and the API trusts that header from loopback only
 * (ADR 0009). Without it every visitor would share the store's own address and one limit.
 */

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

class ShareUnavailable extends Error {}

/** The link's share of `kind`, or null for an unknown, revoked or malformed token. */
export async function readShare(kind: ShareKind, token: string): Promise<PublicShare | null> {
  if (!TOKEN.test(token)) return null;
  const visitor = (await headers()).get('x-forwarded-for');
  const response = await fetch(`${apiInternalUrl()}/api/shares/${token}`, {
    cache: 'no-store',
    headers: { accept: 'application/json', ...(visitor && { 'x-forwarded-for': visitor }) },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new ShareUnavailable(`GET /api/shares answered ${response.status}`);
  const share = (await response.json()) as PublicShare;
  return share.kind === kind ? share : null;
}
