import { describe, expect, it } from 'vitest';
import { cancelOrder, getOrder, listOrders, revealCode } from './requests';

/** A fetch that answers with one response and records what was asked. */
function fetcher(status: number, body: unknown) {
  const calls: { url: string; method: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const page = { items: [], nextCursor: null };

describe('listOrders', () => {
  it('reads the first page, then the page after a cursor', async () => {
    const { fetch, calls } = fetcher(200, page);
    await expect(listOrders(undefined, fetch)).resolves.toEqual({ ok: true, data: page });
    await listOrders('abc=', fetch);
    expect(calls.map((call) => call.url)).toEqual(['/api/orders', '/api/orders?cursor=abc%3D']);
  });

  it('reports a missing session as UNAUTHORIZED', async () => {
    const { fetch } = fetcher(401, { code: 'UNAUTHORIZED' });
    await expect(listOrders(undefined, fetch)).resolves.toEqual({
      ok: false,
      reason: 'UNAUTHORIZED',
    });
  });
});

describe('getOrder', () => {
  it('reads one order, and another customer’s as NOT_FOUND', async () => {
    const ok = fetcher(200, { id: 'o1' });
    await expect(getOrder('o1', ok.fetch)).resolves.toEqual({ ok: true, data: { id: 'o1' } });
    expect(ok.calls).toEqual([{ url: '/api/orders/o1', method: 'GET' }]);
    const missing = fetcher(404, { code: 'NOT_FOUND' });
    await expect(getOrder('o2', missing.fetch)).resolves.toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });
});

describe('revealCode', () => {
  it('posts to the code’s reveal route', async () => {
    const revealed = { code: 'ABCD-1234', firstRevealedAt: '2026-10-09T10:00:00.000Z' };
    const { fetch, calls } = fetcher(200, revealed);
    await expect(revealCode('o1', 'c1', fetch)).resolves.toEqual({ ok: true, data: revealed });
    expect(calls).toEqual([{ url: '/api/orders/o1/codes/c1/reveal', method: 'POST' }]);
  });

  it('reports the rate limit', async () => {
    const { fetch } = fetcher(429, { code: 'RATE_LIMITED' });
    await expect(revealCode('o1', 'c1', fetch)).resolves.toEqual({
      ok: false,
      reason: 'RATE_LIMITED',
    });
  });
});

describe('cancelOrder (rule RS8)', () => {
  it('posts the cancel, and answers a paid order with its code', async () => {
    const ok = fetcher(200, { id: 'o1', stage: 'cancelled' });
    await expect(cancelOrder('o1', ok.fetch)).resolves.toEqual({
      ok: true,
      data: { id: 'o1', stage: 'cancelled' },
    });
    expect(ok.calls).toEqual([{ url: '/api/orders/o1/cancel', method: 'POST' }]);
    const paid = fetcher(409, { code: 'ORDER_NOT_CANCELLABLE', details: { status: 'paid' } });
    await expect(cancelOrder('o1', paid.fetch)).resolves.toEqual({
      ok: false,
      reason: 'ORDER_NOT_CANCELLABLE',
      details: { status: 'paid' },
    });
  });
});
