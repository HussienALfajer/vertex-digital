/*
 * Direct buy links (S22 DL2–DL4): the `/q/<code>` route hands the link's code and campaign to the
 * game page in a short cookie (never in the visible URL), which the page moves into this tab's
 * session storage at once. An order of that pack from the same tab within 24 hours carries them.
 * No contracts import: the game page loads this at once.
 */

export const QUICK_LINK_COOKIE = 'vd-quick-link';

/** The cookie lives only for the redirect, on the game pages only; it expires by itself. */
export const QUICK_LINK_COOKIE_SECONDS = 300;

const STORAGE_KEY = 'vd-quick-link';

/** DL4: an order carries the link for 24 hours after the open. */
const ATTRIBUTION_MS = 24 * 60 * 60 * 1000;

const CODE = /^[2-9A-HJKMNP-Z]{6}$/;
const CAMPAIGN = /^[a-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QuickLinkOpen {
  code: string;
  productId: string;
  campaign: string | null;
}

interface StoredVisit extends QuickLinkOpen {
  openedAt: number;
}

/** `K7M2QX.<product id>.whatsapp`: every part checked again on the way back. */
export function quickLinkCookieValue(open: QuickLinkOpen): string {
  return `${open.code}.${open.productId}.${open.campaign ?? ''}`;
}

export function parseQuickLinkCookie(value: string | undefined): QuickLinkOpen | null {
  const [code = '', productId = '', campaign = '', ...rest] = (value ?? '').split('.');
  if (rest.length > 0 || !CODE.test(code) || !UUID.test(productId)) return null;
  if (campaign !== '' && !CAMPAIGN.test(campaign)) return null;
  return { code, productId, campaign: campaign || null };
}

/** The game page's first step after a link: the cookie into this tab's session storage. */
export function takeQuickLinkCookie(now = Date.now()): void {
  const raw = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${QUICK_LINK_COOKIE}=`))
    ?.slice(QUICK_LINK_COOKIE.length + 1);
  const open = parseQuickLinkCookie(raw && decodeURIComponent(raw));
  if (!open) return;
  try {
    const visit: StoredVisit = { ...open, openedAt: now };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(visit));
  } catch {
    // Without storage the order simply carries no attribution.
  }
}

/** DL4: what an order of `productId` from this tab carries, within 24 hours of the open. */
export function quickLinkFor(
  productId: string,
  now = Date.now(),
): { code: string; campaign?: string } | undefined {
  let visit: StoredVisit | null = null;
  try {
    visit = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as StoredVisit | null;
  } catch {
    return undefined;
  }
  if (
    !visit ||
    visit.productId !== productId ||
    typeof visit.openedAt !== 'number' ||
    now - visit.openedAt > ATTRIBUTION_MS ||
    !parseQuickLinkCookie(quickLinkCookieValue(visit))
  ) {
    return undefined;
  }
  return { code: visit.code, ...(visit.campaign && { campaign: visit.campaign }) };
}
