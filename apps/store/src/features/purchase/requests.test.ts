import { describe, expect, it } from 'vitest';
import { checkPlayer, createOrder } from './requests';

function fetcher(status: number, body: unknown) {
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const productId = '0199c3a4-0000-7000-8000-000000000001';

describe('checkPlayer (rule PV1)', () => {
  it('sends the product and the fields', async () => {
    const { fetch, calls } = fetcher(200, { result: 'valid', playerName: 'Lina' });
    await expect(
      checkPlayer({ productId, fields: { player_id: '51234567' } }, fetch),
    ).resolves.toEqual({ ok: true, data: { result: 'valid', playerName: 'Lina' } });
    expect(calls[0]).toMatchObject({
      url: '/api/player-checks',
      method: 'POST',
      body: { productId, fields: { player_id: '51234567' } },
    });
  });

  it('reports a limit as RATE_LIMITED', async () => {
    const { fetch } = fetcher(429, { code: 'RATE_LIMITED' });
    await expect(checkPlayer({ productId, fields: {} }, fetch)).resolves.toEqual({
      ok: false,
      reason: 'RATE_LIMITED',
    });
  });
});

describe('createOrder (rule BB6)', () => {
  const body = {
    productId,
    quantity: 1,
    fields: { player_id: '51234567' },
    expectedUnitPriceUsdUnits: 1_000_000,
    whenBalanceShort: 'reserve' as const,
    confirmPlayer: true,
  };

  it('sends the body with its Idempotency-Key', async () => {
    const { fetch, calls } = fetcher(201, { id: 'o1' });
    await expect(createOrder(body, 'key-1', fetch)).resolves.toEqual({
      ok: true,
      data: { id: 'o1' },
    });
    expect(calls[0]?.url).toBe('/api/orders');
    expect(calls[0]?.headers.get('idempotency-key')).toBe('key-1');
    expect(calls[0]?.body).toEqual(body);
  });

  it('answers a refusal with its code and details', async () => {
    const { fetch } = fetcher(409, {
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: 1_100_000 },
    });
    await expect(createOrder(body, 'key-2', fetch)).resolves.toEqual({
      ok: false,
      reason: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: 1_100_000 },
    });
  });
});
