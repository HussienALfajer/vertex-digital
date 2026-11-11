import { describe, expect, it } from 'vitest';
import { isShopSlug, shopApi, shopNext, shopPath, shopScope } from './paths';
import {
  answerReturnRequest,
  createShopOrder,
  getShopOrder,
  listShopOrders,
  listShopWalletEntries,
  replyToShopTicket,
  shopAcceptInvitation,
  shopSignIn,
} from './requests';

type Call = { url: string; init?: RequestInit };

function fetcher(...answers: [status: number, body: unknown][]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const header = (call: Call | undefined, name: string) =>
  (call?.init?.headers as Record<string, string> | undefined)?.[name];

describe('shop paths (S26)', () => {
  it('accepts the slugs SH2 allows and nothing else', () => {
    for (const slug of ['abu-ali', 'shop1', 'a1b']) expect(isShopSlug(slug)).toBe(true);
    for (const slug of ['ab', '-abc', 'abc-', 'Abc', 'a/b', 'a'.repeat(31), '../x']) {
      expect(isShopSlug(slug)).toBe(false);
    }
  });

  it('builds the shop’s pages, its worker scope and its API', () => {
    expect(shopPath('abu-ali')).toBe('/s/abu-ali');
    expect(shopPath('abu-ali', '/orders')).toBe('/s/abu-ali/orders');
    expect(shopScope('abu-ali')).toBe('/s/abu-ali');
    expect(shopApi('abu-ali', '/me')).toBe('/api/shops/abu-ali/me');
  });

  it.each([
    [null, '/s/abu-ali'],
    ['/s/abu-ali/orders/VD-1', '/s/abu-ali/orders/VD-1'],
    ['/s/other/orders', '/s/abu-ali'],
    ['/s/abu-ali', '/s/abu-ali'],
    ['/wallet', '/s/abu-ali'],
    ['https://evil.example/s/abu-ali/', '/s/abu-ali'],
    ['//evil.example', '/s/abu-ali'],
    ['/s/abu-ali/\\evil', '/s/abu-ali'],
    ['/s/abu-ali/../../wallet', '/s/abu-ali'],
    ['/s/abu-ali/%2e%2e/%2e%2e/wallet', '/s/abu-ali'],
    ['/s/abu-alim/orders', '/s/abu-ali'],
    ['/s/abu-ali/orders?x=1', '/s/abu-ali/orders?x=1'],
  ])('sends a sign-in back inside the shop only: %s', (next, expected) => {
    expect(shopNext('abu-ali', next)).toBe(expected);
  });
});

describe('shop requests (S26)', () => {
  it('signs in with the shop’s own auth instance, never the store’s', async () => {
    const { fetch, calls } = fetcher([200, {}]);
    await expect(
      shopSignIn('abu-ali', 'a@example.com', 'secret', { fetcher: fetch }),
    ).resolves.toMatchObject({ ok: true });
    expect(calls[0]?.url).toBe('/api/shops/abu-ali/auth/sign-in/email');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: 'a@example.com',
      password: 'secret',
    });
  });

  it('maps an unverified account and a wrong password to their codes', async () => {
    const { fetch } = fetcher(
      [403, { code: 'EMAIL_NOT_VERIFIED' }],
      [401, { code: 'INVALID_EMAIL_OR_PASSWORD' }],
    );
    await expect(shopSignIn('s1x', 'a@example.com', 'x', { fetcher: fetch })).resolves.toEqual({
      ok: false,
      reason: 'EMAIL_NOT_VERIFIED',
    });
    await expect(shopSignIn('s1x', 'a@example.com', 'x', { fetcher: fetch })).resolves.toEqual({
      ok: false,
      reason: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });

  it('pays with the attempt’s key and the selling price shown (PR5)', async () => {
    const { fetch, calls } = fetcher([201, { number: 'VD-1' }]);
    const body = {
      productId: '0193a1b2-0000-7000-8000-000000000001',
      quantity: 2,
      fields: { player_id: '5123' },
      expectedUnitSellUsdUnits: 1_250_000,
      confirmPlayer: false,
    };
    await createShopOrder('abu-ali', body, 'key-1', fetch);
    expect(calls[0]?.url).toBe('/api/shops/abu-ali/orders');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(header(calls[0], 'idempotency-key')).toBe('key-1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
  });

  it('answers a return request with its key (WL5)', async () => {
    const { fetch, calls } = fetcher([201, {}], [200, {}]);
    await answerReturnRequest('abu-ali', 'r1', 'confirm', 'k', fetch);
    await answerReturnRequest('abu-ali', 'r1', 'decline', 'k2', fetch);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/shops/abu-ali/return-requests/r1/confirm',
      '/api/shops/abu-ali/return-requests/r1/decline',
    ]);
    expect(header(calls[0], 'idempotency-key')).toBe('k');
  });

  it('pages with the cursor and escapes path values', async () => {
    const { fetch, calls } = fetcher([200, {}], [200, {}], [200, {}], [200, {}]);
    await listShopOrders('abu-ali', { cursor: 'c1' }, fetch);
    await listShopOrders('abu-ali', {}, fetch);
    await listShopWalletEntries('abu-ali', { cursor: 'c 2' }, fetch);
    await getShopOrder('abu-ali', 'VD/1', fetch);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/shops/abu-ali/orders?cursor=c1',
      '/api/shops/abu-ali/orders',
      '/api/shops/abu-ali/wallet/entries?cursor=c+2',
      '/api/shops/abu-ali/orders/VD%2F1',
    ]);
  });

  it('sends a ticket reply as multipart with its key, and the invitation’s token', async () => {
    const { fetch, calls } = fetcher([201, {}], [200, {}]);
    await replyToShopTicket('abu-ali', 't1', 'شكراً', 'k', fetch);
    expect(calls[0]?.url).toBe('/api/shops/abu-ali/tickets/t1/messages');
    expect((calls[0]?.init?.body as FormData | undefined)?.get('body')).toBe('شكراً');
    expect(header(calls[0], 'idempotency-key')).toBe('k');
    await shopAcceptInvitation('abu-ali', { token: 't'.repeat(30), password: 'p' }, fetch);
    expect(calls[1]?.url).toBe('/api/shops/abu-ali/auth/invitation');
  });
});
