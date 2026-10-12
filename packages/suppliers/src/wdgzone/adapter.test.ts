import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SupplierError } from '../core/errors.js';
import { hmacSha256 } from '../core/hmac.js';
import { type FakeHttpServer, startFakeHttpServer } from '../testing/fake-http-server.js';
import { WDG_SIGNATURE_HEADER, WdgzoneAdapter } from './adapter.js';

/*
 * The WDGZone adapter against the local fake server, with replies recorded from the live API on
 * 2026-10-12 or copied from its documentation, sanitized (docs/suppliers/wdgzone.md, "Fixtures").
 * Nothing here calls WDGZone.
 */

const API_KEY = 'wdg_live_test_key_for_fixtures_only';
const NOW = new Date('2026-08-07T12:31:00Z');
const KEY = '0190f1c2-7a3b-7c4d-8e5f-0123456789ab';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

let server: FakeHttpServer;
let sleeps: number[];

const adapter = (options: { callbackUrl?: string; timeoutMs?: number } = {}) =>
  new WdgzoneAdapter({
    apiKey: API_KEY,
    baseUrl: `${server.url}/api/v1/`,
    // Generous: a busy CI runner must not turn an ordinary reply into a timeout.
    timeoutMs: options.timeoutMs ?? 5_000,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(options.callbackUrl && { callbackUrl: options.callbackUrl }),
  });

const order = (overrides: Partial<Parameters<WdgzoneAdapter['placeOrder']>[0]> = {}) => ({
  idempotencyKey: KEY,
  offerId: '235203',
  quantity: 1,
  fields: { player_id: '5000000001' },
  ...overrides,
});

const sentSince = (count: number) => server.requests.slice(count);

beforeAll(async () => {
  server = await startFakeHttpServer();
});

afterAll(() => server.close());

beforeEach(() => {
  sleeps = [];
});

describe('WdgzoneAdapter catalog', () => {
  it('lists top-ups then vouchers, page by page, as offers', async () => {
    const before = server.requests.length;
    server.reply(
      { body: fixture('products-topup-page-1') },
      { body: fixture('products-topup-page-2') },
      { body: fixture('products-voucher-page-1') },
    );
    const offers = await adapter().listOffers();

    expect(sentSince(before).map((request) => request.path)).toEqual([
      '/api/v1/products?type=topup&limit=100&page=1',
      '/api/v1/products?type=topup&limit=100&page=2',
      '/api/v1/products?type=voucher&limit=100&page=1',
    ]);
    expect(server.requests.at(-1)?.headers['x-api-key']).toBe(API_KEY);
    expect(offers).toEqual([
      {
        offerId: '235203',
        name: 'Auto · 60 UC',
        cost: { currency: 'USD', amountUnits: 881_000 },
        inStock: true,
        group: 'PUBG Mobile',
        kind: 'direct',
        requiredFields: ['player_id'],
      },
      {
        // The category is the game itself: no repeat in the name.
        offerId: '264294',
        name: 'Golden Spin',
        cost: { currency: 'USD', amountUnits: 751_000 },
        inStock: true,
        group: '8 Ball Pool',
        kind: 'direct',
        requiredFields: ['user_id'],
      },
      // 264322 needs two account fields: left out (FIELDS_UNSUPPORTED).
      {
        // No fields listed but a player is required; no stock.
        offerId: '264179',
        name: 'MENA · 110 Diamonds',
        cost: { currency: 'USD', amountUnits: 920_000 },
        inStock: false,
        group: 'Free Fire',
        kind: 'direct',
        requiredFields: ['player_id'],
      },
      {
        // The documented example: no brand, no fields.
        offerId: '8451',
        name: 'Steam Wallet 10 USD',
        cost: { currency: 'USD', amountUnits: 10_475_000 },
        inStock: true,
        group: 'USA / USD',
        kind: 'code',
        requiredFields: [],
      },
      {
        offerId: '306788',
        name: '7 Days to Die',
        cost: { currency: 'USD', amountUnits: 17_975_000 },
        inStock: false,
        group: 'Steam Game Keys',
        kind: 'code',
        requiredFields: [],
      },
    ]);
    expect(sleeps).toEqual([]);
  });

  it('converts prices exactly and leaves out products it cannot sell', async () => {
    const product = (id: number, price: unknown, extra: Record<string, unknown> = {}) => ({
      id,
      name: `P${id}`,
      category: 'C',
      brand: 'B',
      type: 'voucher',
      price,
      currency: 'USD',
      stock: 1,
      available: true,
      requires_player_id: false,
      ...extra,
    });
    server.reply(
      { body: { success: true, data: [], pagination: { page: 1, total_pages: 0 } } },
      {
        body: {
          success: true,
          data: [
            product(1, 0.000001),
            product(2, 4344.032),
            product(3, '0.1'),
            product(4, 999999999.999999),
            product(5, 1e-7),
            product(6, -1),
            product(7, 'abc'),
            product(8, 1.5, { currency: 'EUR' }),
            product(9, 1.5, { type: 'manual' }),
            product(11, 1.5, {
              type: 'topup',
              requires_player_id: true,
              required_fields: [{ key: 'region', label: 'Region', type: 'select', options: [] }],
            }),
            { id: 10, name: 'No price' },
          ],
          pagination: { page: 1, total_pages: 1 },
        },
      },
    );
    const offers = await adapter().listOffers();
    expect(offers.map((offer) => [offer.offerId, offer.cost.amountUnits])).toEqual([
      ['1', 1],
      ['2', 4_344_032_000],
      ['3', 100_000],
      ['4', 999_999_999_999_999],
    ]);
  });

  it('waits for the rate-limit window when few requests are left in it', async () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 30;
    const page = (n: number, total: number, remaining: string) => ({
      body: { success: true, data: [], pagination: { page: n, total_pages: total } },
      headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': String(reset) },
    });
    server.reply(page(1, 0, '21'), page(1, 0, '20'));
    await adapter().listOffers();
    expect(sleeps).toEqual([31_000]);
  });

  it('fails the read on an error, an unreadable page or a runaway catalog', async () => {
    server.reply({ status: 503, body: 'Bad gateway' });
    await expect(adapter().listOffers()).rejects.toMatchObject({ kind: 'retryable' });
    server.reply({ body: { success: true, data: {} } });
    await expect(adapter().listOffers()).rejects.toMatchObject({ kind: 'retryable' });
    server.reply({
      body: { success: true, data: [{}], pagination: { page: 1, total_pages: 10_000 } },
    });
    await expect(adapter().listOffers()).rejects.toThrow('larger than expected');
  });
});

describe('WdgzoneAdapter balance and players', () => {
  it('reads the wallet in micro-dollars', async () => {
    server.reply({ body: fixture('me') });
    expect(await adapter().getBalance()).toEqual({ currency: 'USD', amountUnits: 125_750_000 });
    expect(server.requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/me' });
  });

  it('refuses another currency, an unreadable amount and a rejected key', async () => {
    server.reply({ body: { success: true, data: { balance: 1, currency: 'EUR' } } });
    await expect(adapter().getBalance()).rejects.toThrow('unexpected amount or currency');
    server.reply({ body: { success: true, data: { balance: '1e3', currency: 'USD' } } });
    await expect(adapter().getBalance()).rejects.toThrow('unexpected amount or currency');
    server.reply({ status: 401, body: fixture('error-unauthorized') });
    await expect(adapter().getBalance()).rejects.toMatchObject({
      kind: 'retryable',
      details: { status: 401, supplierCode: 'UNAUTHORIZED' },
    });
  });

  it('does not check players', async () => {
    const wdg = adapter();
    expect(wdg.capabilities).toEqual({
      validatePlayer: false,
      webhooks: true,
      balance: true,
      catalog: true,
    });
    await expect(wdg.validatePlayer()).rejects.toBeInstanceOf(SupplierError);
  });
});

describe('WdgzoneAdapter placeOrder', () => {
  it('sends the attempt id as the idempotency key, the player and the callback', async () => {
    server.reply({ status: 201, body: fixture('purchase-completed') });
    const outcome = await adapter({
      callbackUrl: 'https://store.test/api/webhooks/suppliers/wdgzone',
    }).placeOrder(order({ offerId: '8451', fields: { player_id: '5000000001' } }));

    expect(outcome).toEqual({
      status: 'delivered',
      supplierOrderId: '1024',
      quantity: 1,
      codes: ['TEST-CODE-0001'],
    });
    const sent = server.requests.at(-1);
    expect(sent).toMatchObject({ method: 'POST', path: '/api/v1/products/8451/purchase' });
    expect(sent?.headers['x-idempotency-key']).toBe(KEY);
    expect(sent?.headers['x-api-key']).toBe(API_KEY);
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      quantity: 1,
      player_id: '5000000001',
      callback_url: 'https://store.test/api/webhooks/suppliers/wdgzone',
    });
  });

  it('answers a repeated key with the same order, never a second one', async () => {
    // WDG replays an order's key with 200 and the original order (its OpenAPI document).
    server.reply(
      { status: 201, body: fixture('purchase-completed') },
      {
        status: 200,
        body: fixture('purchase-completed'),
      },
    );
    const wdg = adapter();
    const first = await wdg.placeOrder(order());
    const again = await wdg.placeOrder(order());
    expect(again).toEqual(first);
    expect(
      server.requests.slice(-2).map((request) => request.headers['x-idempotency-key']),
    ).toEqual([KEY, KEY]);
  });

  it('sends no player for a code and no callback without a public URL', async () => {
    server.reply({ status: 201, body: fixture('purchase-completed') });
    await adapter().placeOrder(order({ fields: {} }));
    expect(JSON.parse(server.requests.at(-1)?.body ?? '')).toEqual({ quantity: 1 });
  });

  it('follows any state but completed by polling', async () => {
    for (const status of ['processing', 'pending', 'failed', 'COMPLETED_LATER']) {
      server.reply({
        status: 201,
        body: { success: true, data: { order_id: 2048, status, delivery_items: [] } },
      });
      expect(await adapter().placeOrder(order())).toEqual({
        status: 'pending',
        supplierOrderId: '2048',
      });
    }
    // A completed top-up has no items: delivered without codes.
    server.reply({
      status: 201,
      body: { success: true, data: { order_id: 2049, status: 'COMPLETED' } },
    });
    expect(await adapter().placeOrder(order({ quantity: 3 }))).toEqual({
      status: 'delivered',
      supplierOrderId: '2049',
      quantity: 3,
    });
  });

  it.each([
    [422, 'error-insufficient-balance', 'INSUFFICIENT_BALANCE'],
    [422, 'error-player-id-required', 'PLAYER_ID_REQUIRED'],
    [404, 'error-product-not-found', 'PRODUCT_NOT_FOUND'],
    [409, 'error-out-of-stock', 'OUT_OF_STOCK'],
  ])('maps a %i %s refusal as definitive', async (status, name, code) => {
    server.reply({ status, body: fixture(name) });
    expect(await adapter().placeOrder(order())).toMatchObject({
      status: 'failed_definitive',
      supplierCode: code,
    });
  });

  it.each([
    ['a rejected key', { status: 401, body: fixture('error-unauthorized') }],
    ['a rate limit', { status: 429, body: { success: false, error: { code: 'RATE_LIMITED' } } }],
    ['another conflict', { status: 409, body: { success: false, error: { code: 'BUSY' } } }],
    ['an unmapped refusal', { status: 422, body: { success: false, error: { code: 'NEW' } } }],
    ['a server error', { status: 500, body: 'Internal error' }],
    ['an unreadable reply', { status: 201, body: '<html>' }],
    ['an unexpected shape', { status: 201, body: { success: true, data: { status: 'ok' } } }],
  ])('maps %s after sending as unknown', async (_, reply) => {
    server.reply(reply);
    expect(await adapter().placeOrder(order())).toMatchObject({ status: 'unknown' });
  });

  it('maps a timeout after sending as unknown', async () => {
    server.reply({ status: 201, body: fixture('purchase-completed'), delayMs: 500 });
    expect(await adapter({ timeoutMs: 50 }).placeOrder(order())).toEqual({
      status: 'unknown',
      reason: 'Supplier timed out',
    });
  });

  it('maps a refused connection as unknown, never as a failure', async () => {
    const closed = await startFakeHttpServer();
    const url = closed.url;
    await closed.close();
    const wdg = new WdgzoneAdapter({ apiKey: API_KEY, baseUrl: `${url}/api/v1/` });
    expect(await wdg.placeOrder(order())).toMatchObject({ status: 'unknown' });
  });

  it.each([
    ['a product id that is not WDG’s', order({ offerId: '../me' }), 'PRODUCT_NOT_FOUND'],
    [
      'a key longer than 100',
      order({ idempotencyKey: 'k'.repeat(101) }),
      'IDEMPOTENCY_KEY_TOO_LONG',
    ],
    [
      'two account fields',
      order({ fields: { user_id: '1', server_id: '2' } }),
      'FIELDS_UNSUPPORTED',
    ],
  ])('refuses %s without sending anything', async (_, request, code) => {
    const before = server.requests.length;
    expect(await adapter().placeOrder(request)).toMatchObject({
      status: 'failed_definitive',
      supplierCode: code,
    });
    expect(server.requests.length).toBe(before);
  });
});

describe('WdgzoneAdapter getOrder', () => {
  const placed = { supplierOrderId: '1024', quantity: 2 };

  it('polls the delivery by WDG’s order id', async () => {
    server.reply({ status: 202, body: { success: true, data: { status: 'processing' } } });
    expect(await adapter().getOrder(KEY, placed)).toEqual({
      status: 'pending',
      supplierOrderId: '1024',
    });
    expect(server.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: '/api/v1/orders/1024/delivery',
    });

    server.reply({
      body: { success: true, data: { delivery_items: ['TEST-CODE-0001', 'TEST-CODE-0002'] } },
    });
    expect(await adapter().getOrder(KEY, placed)).toEqual({
      status: 'delivered',
      supplierOrderId: '1024',
      quantity: 2,
      codes: ['TEST-CODE-0001', 'TEST-CODE-0002'],
    });
  });

  it('maps 410 as failed and refunded', async () => {
    server.reply({ status: 410, body: { success: false, error: { code: 'ORDER_REFUNDED' } } });
    expect(await adapter().getOrder(KEY, placed)).toEqual({
      status: 'failed_definitive',
      supplierOrderId: '1024',
      supplierCode: 'ORDER_REFUNDED',
      reason: 'Failed and refunded by WDGZone',
    });
    server.reply({ status: 410, body: '' });
    expect(await adapter().getOrder(KEY, placed)).toMatchObject({ supplierCode: 'ORDER_FAILED' });
  });

  it.each([
    ['not found', { status: 404, body: fixture('error-order-not-found') }],
    ['a server error', { status: 502, body: 'Bad gateway' }],
    ['an unexpected status', { status: 204, body: '' }],
    [
      'an unreadable delivery',
      { status: 200, body: { success: true, data: { delivery_items: 'x' } } },
    ],
    ['other units', { status: 200, body: { success: true, data: { quantity: 1 } } }],
  ])('maps %s as unknown', async (_, reply) => {
    server.reply(reply);
    expect(await adapter().getOrder(KEY, placed)).toMatchObject({
      status: 'unknown',
      supplierOrderId: '1024',
    });
  });

  it('asks nothing without WDG’s order id', async () => {
    const before = server.requests.length;
    for (const known of [undefined, { quantity: 1 }, { supplierOrderId: '1/../2', quantity: 1 }]) {
      expect(await adapter().getOrder(KEY, known)).toMatchObject({ status: 'unknown' });
    }
    expect(server.requests.length).toBe(before);
  });
});

describe('WdgzoneAdapter webhooks', () => {
  // WDG signs with the SHA-256 hex of the API key as the HMAC secret (its documentation).
  const secret = createHash('sha256').update(API_KEY).digest('hex');
  const body = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => {
    const base = fixture('webhook-order-completed') as Record<string, unknown>;
    return JSON.stringify({
      ...base,
      ...overrides,
      data: { ...(base.data as Record<string, unknown>), ...data },
    });
  };
  const signed = (rawBody: string, key = secret) => ({
    headers: { [WDG_SIGNATURE_HEADER]: `sha256=${hmacSha256(key, rawBody)}` },
    rawBody,
  });

  it('accepts the exact signed body within a day of its time', () => {
    const wdg = adapter();
    expect(wdg.verifyWebhook(signed(body()))).toBe(true);
    expect(wdg.verifyWebhook(signed(body()), new Date('2026-08-08T12:00:00Z'))).toBe(true);
  });

  it('refuses a wrong, missing or bare signature, a changed body and a stale event', () => {
    const wdg = adapter();
    const rawBody = body();
    const good = signed(rawBody);
    expect(wdg.verifyWebhook(signed(rawBody, 'not-the-secret'))).toBe(false);
    expect(wdg.verifyWebhook({ headers: {}, rawBody })).toBe(false);
    expect(
      wdg.verifyWebhook({
        headers: { [WDG_SIGNATURE_HEADER]: good.headers[WDG_SIGNATURE_HEADER].slice(7) },
        rawBody,
      }),
    ).toBe(false);
    expect(wdg.verifyWebhook({ ...good, rawBody: rawBody.replace('1024', '1025') })).toBe(false);
    expect(wdg.verifyWebhook(good, new Date('2026-08-08T12:30:01Z'))).toBe(false);
    expect(wdg.verifyWebhook(signed(body({ created_at: 'yesterday' })))).toBe(false);
    expect(wdg.verifyWebhook(signed('not json'))).toBe(false);
    expect(new WdgzoneAdapter({ apiKey: '' }).verifyWebhook(signed(rawBody, ''))).toBe(false);
  });

  it('reads a completed order by WDG’s order id, with its event id for replays', () => {
    const event = adapter().parseWebhook(signed(body()));
    expect(event).toEqual({
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      supplierOrderId: '1024',
      outcome: {
        status: 'delivered',
        supplierOrderId: '1024',
        quantity: 1,
        codes: ['TEST-CODE-0001'],
      },
    });
    // The same delivery again carries the same event id: the API stores it once.
    expect(adapter().parseWebhook(signed(body())).eventId).toBe(event.eventId);
  });

  it.each(['order.failed', 'order.refunded'])('reads %s as failed', (name) => {
    expect(
      adapter().parseWebhook(
        signed(body({ event: name }, { status: 'FAILED', delivery_items: [], refunded: true })),
      ).outcome,
    ).toEqual({
      status: 'failed_definitive',
      supplierOrderId: '1024',
      supplierCode: name,
      reason: 'Failed by WDGZone',
    });
  });

  it('refuses a malformed or contradictory event', () => {
    for (const rawBody of [
      'not json',
      body({ event: 'order.created' }),
      body({}, { order_id: 'x' }),
      body({}, { refunded: true }),
    ]) {
      expect(() => adapter().parseWebhook({ headers: {}, rawBody })).toThrow(SupplierError);
    }
  });
});
