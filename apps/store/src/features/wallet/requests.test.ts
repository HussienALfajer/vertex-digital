import { describe, expect, it } from 'vitest';
import { getWallet, listWalletEntries } from './requests';

/** A fetch that answers with one response and records the URL asked for. */
function fetcher(status: number, body: unknown) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

describe('getWallet', () => {
  it('reads the session customer’s balance', async () => {
    const { fetch, urls } = fetcher(200, { balanceUnits: 12_500_000, syp: null });
    await expect(getWallet(fetch)).resolves.toEqual({
      ok: true,
      data: { balanceUnits: 12_500_000, syp: null },
    });
    expect(urls).toEqual(['/api/wallet']);
  });

  it('reports a missing session as UNAUTHORIZED', async () => {
    const { fetch } = fetcher(401, { code: 'UNAUTHORIZED' });
    await expect(getWallet(fetch)).resolves.toEqual({ ok: false, reason: 'UNAUTHORIZED' });
  });
});

describe('listWalletEntries', () => {
  it('reads the first page without a cursor, then the next one with it', async () => {
    const { fetch, urls } = fetcher(200, { items: [], nextCursor: null });
    await listWalletEntries(undefined, fetch);
    await listWalletEntries('a b/c', fetch);
    expect(urls).toEqual(['/api/wallet/entries', '/api/wallet/entries?cursor=a+b%2Fc']);
  });
});
