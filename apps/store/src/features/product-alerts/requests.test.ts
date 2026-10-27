import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelProductAlert,
  createProductAlert,
  listProductAlerts,
  readGameAlerts,
} from './requests';

function fetcher(status: number, body: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null });
    return new Response(body === null ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

afterEach(() => vi.unstubAllGlobals());

const GAME = '0199e000-0000-7000-8000-0000000000b1';
const PACK = '0199e000-0000-7000-8000-0000000000c1';

describe('product alerts (S22 PA1, PA6, PA7)', () => {
  it('lists a game’s, the active or the ended ones', async () => {
    const { fetch, calls } = fetcher(200, { items: [] });
    await expect(listProductAlerts({}, fetch)).resolves.toEqual({ ok: true, data: { items: [] } });
    await listProductAlerts({ gameId: GAME }, fetch);
    await listProductAlerts({ status: 'ended' }, fetch);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/product-alerts',
      `/api/product-alerts?gameId=${GAME}`,
      '/api/product-alerts?status=ended',
    ]);
  });

  it('sets one without a price and cancels one', async () => {
    const set = fetcher(201, { id: 'a1' });
    await createProductAlert(PACK, 'price_drop', set.fetch);
    expect(set.calls).toEqual([
      {
        url: '/api/product-alerts',
        method: 'POST',
        body: JSON.stringify({ productId: PACK, kind: 'price_drop' }),
      },
    ]);
    const refused = fetcher(409, { code: 'PRODUCT_ALERTS_LIMIT_REACHED', details: { limit: 30 } });
    await expect(createProductAlert(PACK, 'available', refused.fetch)).resolves.toMatchObject({
      ok: false,
      reason: 'PRODUCT_ALERTS_LIMIT_REACHED',
    });
    const cancelled = fetcher(204, null);
    await expect(cancelProductAlert('a1', cancelled.fetch)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(cancelled.calls[0]).toMatchObject({ url: '/api/product-alerts/a1', method: 'DELETE' });
  });

  it('reads a game’s alerts once, again after any change (audit A04-40)', async () => {
    const reads = fetcher(200, { items: [] });
    vi.stubGlobal('fetch', reads.fetch);
    await readGameAlerts(GAME);
    await readGameAlerts(GAME);
    expect(reads.calls).toHaveLength(1);
    // "تنبيهاتي" cancels one: the game page reads its alerts again.
    await cancelProductAlert('a1', fetcher(204, null).fetch);
    await readGameAlerts(GAME);
    expect(reads.calls).toHaveLength(2);
  });
});
