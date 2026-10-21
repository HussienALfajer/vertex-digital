import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseQuickLinkCookie,
  quickLinkCookieValue,
  quickLinkFor,
  takeQuickLinkCookie,
} from './handoff';

const PRODUCT = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function fakeBrowser(cookie: string) {
  const store = new Map<string, string>();
  vi.stubGlobal('document', { cookie });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the direct link hand-off (S22 DL2, DL4)', () => {
  it('writes and reads the cookie, refusing anything else', () => {
    const open = { code: 'K7M2QX', productId: PRODUCT, campaign: 'whatsapp' };
    expect(parseQuickLinkCookie(quickLinkCookieValue(open))).toEqual(open);
    expect(parseQuickLinkCookie(quickLinkCookieValue({ ...open, campaign: null }))).toEqual({
      ...open,
      campaign: null,
    });
    for (const value of [
      undefined,
      '',
      'K7M2QX',
      `k7m2qx.${PRODUCT}.`,
      `K7M2QX.x.`,
      `K7M2QX.${PRODUCT}.Bad`,
      `K7M2QX.${PRODUCT}.a.b`,
    ]) {
      expect(parseQuickLinkCookie(value)).toBeNull();
    }
  });

  it('keeps the link for an order of its pack from this tab within 24 hours', () => {
    fakeBrowser(`theme=dark; vd-quick-link=${encodeURIComponent(`K7M2QX.${PRODUCT}.shop`)}`);
    takeQuickLinkCookie(1_000);
    expect(quickLinkFor(PRODUCT, 2_000)).toEqual({ code: 'K7M2QX', campaign: 'shop' });
    expect(quickLinkFor('0199a1b2-c3d4-7e5f-8a9b-000000000000', 2_000)).toBeUndefined();
    expect(quickLinkFor(PRODUCT, 1_000 + 24 * 60 * 60 * 1000 + 1)).toBeUndefined();
  });

  it('keeps nothing without a valid cookie or storage', () => {
    const store = fakeBrowser('vd-quick-link=junk');
    takeQuickLinkCookie();
    expect(store.size).toBe(0);
    expect(quickLinkFor(PRODUCT)).toBeUndefined();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(quickLinkFor(PRODUCT)).toBeUndefined();
  });
});
