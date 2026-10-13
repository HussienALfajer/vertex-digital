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
const ATTEMPT_ID = '0190f1c2-7a3b-7c4d-8e5f-0123456789ab';

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
  idempotencyKey: ATTEMPT_ID,
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
    const player = (key: string, label: string) => [{ key, label, type: 'text' }];
    expect(offers).toEqual([
      {
        offerId: '235203',
        name: 'Auto · 60 UC',
        cost: { currency: 'USD', amountUnits: 881_000 },
        inStock: true,
        group: 'PUBG Mobile',
        kind: 'direct',
        requiredFields: ['player_id'],
        // 999999 is unlimited: no stock figure (S16 SF2).
        categoryId: '14693',
        originalCost: { currency: 'USD', amountUnits: 881_000 },
        fieldSpecs: player('player_id', 'Player ID'),
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
        categoryId: '14845',
        originalCost: { currency: 'USD', amountUnits: 751_000 },
        fieldSpecs: player('user_id', 'Unique ID'),
      },
      {
        // Two fields with an account field (`user_id`): sent as keys (S16 MF1).
        offerId: '264322',
        name: '65 Tokens',
        cost: { currency: 'USD', amountUnits: 1_023_000 },
        inStock: true,
        group: 'Ace Racer',
        kind: 'direct',
        requiredFields: ['user_id', 'server_id'],
        categoryId: '14847',
        originalCost: { currency: 'USD', amountUnits: 1_023_000 },
        fieldSpecs: [
          { key: 'user_id', label: 'User ID', type: 'text' },
          { key: 'server_id', label: 'Server ID', type: 'text' },
        ],
      },
      {
        // No fields listed but a player is required; no stock.
        offerId: '264179',
        name: 'MENA · 110 Diamonds',
        cost: { currency: 'USD', amountUnits: 920_000 },
        inStock: false,
        group: 'Free Fire',
        kind: 'direct',
        requiredFields: ['player_id'],
        categoryId: '14685',
        stock: 0,
        originalCost: { currency: 'USD', amountUnits: 920_000 },
        fieldSpecs: player('player_id', 'Player ID'),
      },
      {
        // The documented example: no brand, no fields, no original price.
        offerId: '8451',
        name: 'Steam Wallet 10 USD',
        cost: { currency: 'USD', amountUnits: 10_475_000 },
        inStock: true,
        group: 'USA / USD',
        kind: 'code',
        requiredFields: [],
        categoryId: '124',
        stock: 48,
        fieldSpecs: [],
      },
      {
        offerId: '306788',
        name: '7 Days to Die',
        cost: { currency: 'USD', amountUnits: 17_975_000 },
        inStock: false,
        group: 'Steam Game Keys',
        kind: 'code',
        requiredFields: [],
        categoryId: '4011391',
        stock: 143,
        originalCost: { currency: 'USD', amountUnits: 17_975_000 },
        fieldSpecs: [],
      },
    ]);
    expect(sleeps).toEqual([]);
  });

  it('keeps unsupported only the fields MF1 and MF2 cannot send (recorded 2026-10-13)', async () => {
    server.reply(
      { body: fixture('products-topup-fields') },
      { body: { success: true, data: [], pagination: { page: 1, total_pages: 0 } } },
    );
    const offers = await adapter().listOffers();
    const byId = new Map(offers.map((offer) => [offer.offerId, offer]));
    // Mobile Legends: player id and server id.
    expect(byId.get('269908')).toMatchObject({
      requiredFields: ['player_id', 'server_id'],
    });
    expect(byId.get('269908')?.unsupportedReason).toBeUndefined();
    // A select whose values differ from its labels: kept whole.
    expect(byId.get('267066')?.fieldSpecs).toEqual([
      { key: 'player_id', label: 'Player ID', type: 'text' },
      {
        key: 'server',
        label: 'Server',
        type: 'select',
        options: [
          { label: 'South America', value: 'south_america' },
          { label: 'North America', value: 'north_america' },
          { label: 'Asia', value: 'asia' },
        ],
      },
    ]);
    expect(byId.get('267066')?.unsupportedReason).toBeUndefined();
    // Email and password, no account field; a one-option select; a 72-option select.
    for (const id of ['271145', '271884', '269192']) {
      expect(byId.get(id)?.unsupportedReason).toBe('fields_unsupported');
    }
    expect(byId.get('269192')?.fieldSpecs?.[1]?.options).toHaveLength(50);
  });

  it('reads a product with a select field as GET /products/{id} answers it', () => {
    const reply = fixture('product-select') as { data: { required_fields: unknown[] } };
    expect(reply.data.required_fields).toEqual([
      { key: 'player_id', label: 'User ID', type: 'text' },
      {
        key: 'platform',
        label: 'Platform',
        type: 'select',
        options: [
          { label: 'Android', value: 'Android' },
          { label: 'Windows', value: 'Windows' },
          { label: 'iOS', value: 'iOS' },
        ],
      },
    ]);
  });

  it('keeps unsupported a select with duplicate or unreadable values', async () => {
    const product = (id: number, options: unknown[]) => ({
      id,
      name: 'Pack',
      category_id: 1,
      brand: 'Game',
      type: 'topup',
      price: 1,
      currency: 'USD',
      available: true,
      requires_player_id: true,
      required_fields: [
        { key: 'player_id', label: 'ID', type: 'text' },
        { key: 'server', label: 'Server', type: 'select', options },
      ],
    });
    const page = (data: unknown[]) => ({
      success: true,
      data,
      pagination: { page: 1, total_pages: 1 },
    });
    server.reply(
      {
        body: page([
          product(1, [
            { label: 'A', value: 'a' },
            { label: 'A again', value: 'a' },
          ]),
          product(2, [
            { label: 'A', value: 'a' },
            { label: 'Long', value: 'x'.repeat(65) },
          ]),
          product(3, [{ value: 'a' }, { value: 7 }]),
        ]),
      },
      { body: page([]) },
    );
    const offers = await adapter().listOffers();
    expect(offers.map((offer) => offer.unsupportedReason ?? null)).toEqual([
      'fields_unsupported',
      'fields_unsupported',
      null,
    ]);
    expect(offers[1]?.fieldSpecs?.[1]?.options).toEqual([{ label: 'A', value: 'a' }]);
    expect(offers[2]?.fieldSpecs?.[1]?.options).toEqual([
      { label: 'a', value: 'a' },
      { label: '7', value: '7' },
    ]);
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
    expect(
      offers.map((offer) => [offer.offerId, offer.cost.amountUnits, offer.unsupportedReason]),
    ).toEqual([
      ['1', 1, undefined],
      ['2', 4_344_032_000, undefined],
      ['3', 100_000, undefined],
      ['4', 999_999_999_999_999, undefined],
      // A select field: kept, unsupported (S16 SC3), with its options.
      ['11', 1_500_000, 'fields_unsupported'],
    ]);
    expect(offers.at(-1)?.fieldSpecs).toEqual([
      { key: 'region', label: 'Region', type: 'select', options: [] },
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
      categories: true,
      statement: true,
      platformStatus: true,
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
    expect(sent?.headers['x-idempotency-key']).toBe(ATTEMPT_ID);
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
    ).toEqual([ATTEMPT_ID, ATTEMPT_ID]);
  });

  it('sends no player for a code and no callback without a public URL', async () => {
    server.reply({ status: 201, body: fixture('purchase-completed') });
    await adapter().placeOrder(order({ fields: {} }));
    expect(JSON.parse(server.requests.at(-1)?.body ?? '')).toEqual({ quantity: 1 });
  });

  it('sends several fields as JSON keys plus player_id from the account field (MF1, MF2)', async () => {
    const body = async (fields: Record<string, string>) => {
      server.reply({ status: 201, body: fixture('purchase-completed') });
      await adapter().placeOrder(order({ fields }));
      return JSON.parse(server.requests.at(-1)?.body ?? '');
    };
    // One field goes as player_id whatever its key.
    expect(await body({ user_id: '5000000001' })).toEqual({ quantity: 1, player_id: '5000000001' });
    expect(await body({ player_id: '5000000001', zone_id: '1234' })).toEqual({
      quantity: 1,
      player_id: '5000000001',
      zone_id: '1234',
    });
    // A select is sent as the supplier's value the worker gives it, under its key.
    expect(await body({ server: 'south_america', user_id: '77' })).toEqual({
      quantity: 1,
      server: 'south_america',
      user_id: '77',
      player_id: '77',
    });
    // `player_id` first, then the list's order; empty values left out.
    expect(await body({ uid: '1', riot_id: '2', player_id: '3' })).toMatchObject({
      player_id: '3',
    });
    expect(await body({ riot_id: '2', role_id: '1', note: '' })).toEqual({
      quantity: 1,
      riot_id: '2',
      role_id: '1',
      player_id: '1',
    });
    expect(await body({ id: '9', server: 'eu' })).toEqual({
      quantity: 1,
      id: '9',
      server: 'eu',
      player_id: '9',
    });
    expect(await body({ user_id: '', server: 'eu' })).toEqual({ quantity: 1, server: 'eu' });
  });

  it('reads codes with pins on the purchase reply (MF4)', async () => {
    server.reply({
      status: 201,
      body: {
        success: true,
        data: {
          order_id: 3001,
          status: 'completed',
          delivery_items: [{ code: 'TEST-CODE-0001', pin: '1234' }, { code: 'TEST-CODE-0002' }],
        },
      },
    });
    expect(await adapter().placeOrder(order({ quantity: 2 }))).toEqual({
      status: 'delivered',
      supplierOrderId: '3001',
      quantity: 2,
      codes: ['TEST-CODE-0001 · PIN: 1234', 'TEST-CODE-0002'],
    });
    for (const items of [
      [{ code: ' ' }],
      ['x'.repeat(201)],
      [{ code: 'C', pin: 'p'.repeat(200) }],
    ]) {
      server.reply({
        status: 201,
        body: {
          success: true,
          data: { order_id: 3002, status: 'completed', delivery_items: items },
        },
      });
      expect(await adapter().placeOrder(order())).toEqual({
        status: 'unknown',
        supplierOrderId: '3002',
        reason: 'WDGZone delivered an unreadable code',
      });
    }
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
      'several fields without an account field',
      order({ fields: { email: 'a@b.test', password: 'x' } }),
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
    server.reply(
      {
        status: 202,
        body: { success: true, data: { status: 'PROCESSING', delivery_items: null } },
      },
      { body: { success: true, data: { status: 'processing' } } },
    );
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toEqual({
      status: 'pending',
      supplierOrderId: '1024',
    });
    expect(server.requests.slice(-2).map((request) => request.path)).toEqual([
      '/api/v1/orders/1024/delivery',
      '/api/v1/orders/1024',
    ]);

    server.reply({
      body: { success: true, data: { delivery_items: ['TEST-CODE-0001', 'TEST-CODE-0002'] } },
    });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toEqual({
      status: 'delivered',
      supplierOrderId: '1024',
      quantity: 2,
      codes: ['TEST-CODE-0001', 'TEST-CODE-0002'],
    });
  });

  it('reads a 200 with pins, and a status other than COMPLETED as unknown (MF4)', async () => {
    server.reply({
      body: {
        success: true,
        data: {
          order_id: 1024,
          status: 'COMPLETED',
          delivery_items: [
            { code: 'TEST-CODE-0001', pin: '1111' },
            { code: 'TEST-CODE-0002', pin: null },
          ],
        },
      },
    });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toEqual({
      status: 'delivered',
      supplierOrderId: '1024',
      quantity: 2,
      codes: ['TEST-CODE-0001 · PIN: 1111', 'TEST-CODE-0002'],
    });
    server.reply({
      body: { success: true, data: { status: 'PROCESSING', delivery_items: ['TEST-CODE-0001'] } },
    });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toEqual({
      status: 'unknown',
      supplierOrderId: '1024',
      reason: 'WDGZone delivery is not completed',
    });
  });

  it.each([
    ['completed', { status: 'delivered', supplierOrderId: '1024', quantity: 2 }],
    ['pending', { status: 'pending', supplierOrderId: '1024' }],
    ['refunded', { status: 'failed_definitive', supplierCode: 'REFUNDED' }],
    ['FAILED', { status: 'failed_definitive', supplierCode: 'FAILED' }],
    ['cancelled', { status: 'failed_definitive', supplierCode: 'CANCELLED' }],
    ['on_hold', { status: 'unknown', reason: 'WDGZone order state unexpected' }],
  ])('reads the order state %s after a 202 (MF4)', async (status, outcome) => {
    server.reply(
      { status: 202, body: { success: true, data: { status: 'PROCESSING' } } },
      { body: { success: true, data: { order_id: 1024, status } } },
    );
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toMatchObject(outcome);
  });

  it('reads an unreadable order state after a 202 as unknown', async () => {
    server.reply({ status: 202, body: {} }, { body: { success: true, data: {} } });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toMatchObject({
      status: 'unknown',
      supplierOrderId: '1024',
    });
    server.reply(
      { status: 202, body: {} },
      { status: 404, body: fixture('error-order-not-found') },
    );
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toMatchObject({ status: 'unknown' });
  });

  it('keeps the 410 body’s data.status as the code (MF4)', async () => {
    server.reply({
      status: 410,
      body: { success: false, data: { status: 'CANCELLED', refunded: true } },
    });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toEqual({
      status: 'failed_definitive',
      supplierOrderId: '1024',
      supplierCode: 'CANCELLED',
      reason: 'Failed and refunded by WDGZone',
    });
  });

  it('maps 410 as failed and refunded', async () => {
    server.reply({ status: 410, body: { success: false, error: { code: 'ORDER_REFUNDED' } } });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toEqual({
      status: 'failed_definitive',
      supplierOrderId: '1024',
      supplierCode: 'ORDER_REFUNDED',
      reason: 'Failed and refunded by WDGZone',
    });
    server.reply({ status: 410, body: '' });
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toMatchObject({
      supplierCode: 'ORDER_FAILED',
    });
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
    expect(await adapter().getOrder(ATTEMPT_ID, placed)).toMatchObject({
      status: 'unknown',
      supplierOrderId: '1024',
    });
  });

  it('asks nothing without WDG’s order id', async () => {
    const before = server.requests.length;
    for (const known of [undefined, { quantity: 1 }, { supplierOrderId: '1/../2', quantity: 1 }]) {
      expect(await adapter().getOrder(ATTEMPT_ID, known)).toMatchObject({ status: 'unknown' });
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

  it('reads codes with pins on the webhook (MF4)', () => {
    const event = adapter().parseWebhook(
      signed(body({}, { delivery_items: [{ code: 'TEST-CODE-0001', pin: 4321 }] })),
    );
    expect(event.outcome).toMatchObject({ codes: ['TEST-CODE-0001 · PIN: 4321'] });
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

describe('WdgzoneAdapter catalog tree, statement and status (S16)', () => {
  it('lists categories with ids, kinds, counts and only images on its own host', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('categories') });
    const categories = await adapter().listCategories();
    expect(sentSince(before).map((request) => request.path)).toEqual(['/api/v1/categories']);
    expect(categories).toEqual([
      {
        categoryId: '120',
        name: 'Steam Wallet',
        kind: 'code',
        productCount: 165,
        inStockCount: 142,
        imageUrl: 'https://wdgzone.tech/panel/category-image.php?name=Steam%20Wallet',
      },
      {
        categoryId: '124',
        parentCategoryId: '120',
        name: 'USA / USD',
        kind: 'code',
        productCount: 12,
        inStockCount: 10,
        imageUrl: 'https://wdgzone.tech/panel/category-image.php?name=Steam%20Wallet',
      },
      // An image on another host is dropped (rule IM1).
      {
        categoryId: '14690',
        name: 'PUBG Mobile',
        kind: 'direct',
        productCount: 14,
        inStockCount: 14,
      },
      { categoryId: '14693', parentCategoryId: '14690', name: 'Auto', kind: 'direct' },
      // `manual` categories are left out, as their products are.
    ]);
  });

  it('follows category pages when WDG sends them, and refuses a runaway tree', async () => {
    const node = (id: number) => ({ id, name: `C${id}`, type: 'topup' });
    server.reply(
      { body: { success: true, data: [node(1)], pagination: { page: 1, total_pages: 2 } } },
      {
        body: {
          success: true,
          data: [node(2), { id: 'x' }],
          pagination: { page: 2, total_pages: 2 },
        },
      },
    );
    const before = server.requests.length;
    expect((await adapter().listCategories()).map((category) => category.categoryId)).toEqual([
      '1',
      '2',
    ]);
    expect(sentSince(before).map((request) => request.path)).toEqual([
      '/api/v1/categories',
      '/api/v1/categories?page=2',
    ]);
    server.reply({
      body: { success: true, data: [node(1)], pagination: { page: 1, total_pages: 10_000 } },
    });
    await expect(adapter().listCategories()).rejects.toThrow('larger than expected');
  });

  it('reads transactions leniently: signed amounts, matches by order id, others left out', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('transactions-page-1') });
    const page = await adapter().listTransactions(1);
    expect(sentSince(before)[0]?.path).toBe('/api/v1/transactions?limit=50&page=1');
    expect(page).toEqual({
      items: [
        {
          id: '9001',
          type: 'purchase',
          amount: { currency: 'USD', amountUnits: -881_000 },
          balanceAfter: { currency: 'USD', amountUnits: 24_119_000 },
          reference: 'Order #1024',
          supplierOrderId: '1024',
          createdAt: new Date('2026-10-12T10:00:00Z'),
        },
        {
          id: '9000',
          type: 'deposit',
          amount: { currency: 'USD', amountUnits: 25_000_000 },
          createdAt: new Date('2026-10-12T09:00:00Z'),
        },
      ],
      hasMore: true,
    });
  });

  it('reads orders leniently, and ends the list on a short page without paging', async () => {
    server.reply({ body: fixture('orders-page-1') });
    expect(await adapter().listOrders(2)).toEqual({
      items: [
        {
          supplierOrderId: '1024',
          offerId: '235203',
          offerName: '60 UC',
          quantity: 1,
          status: 'completed',
          total: { currency: 'USD', amountUnits: 881_000 },
          createdAt: new Date('2026-10-12T10:00:00Z'),
        },
        // Another currency: the total is left out.
        { supplierOrderId: '1023', offerName: 'Steam Wallet 10 USD' },
      ],
      hasMore: false,
    });
    const full = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, total: 'x' }));
    server.reply({ body: { success: true, data: full } });
    expect((await adapter().listOrders(1)).hasMore).toBe(true);
  });

  it('reads the platform status at the top or in data', async () => {
    server.reply({ body: fixture('health') });
    expect(await adapter().getPlatformStatus()).toEqual({
      status: 'operational',
      catalogUpdatedAt: new Date('2026-10-12T09:41:07Z'),
    });
    server.reply({
      body: { success: true, data: { status: 'maintenance', catalog_updated_at: 'x' } },
    });
    expect(await adapter().getPlatformStatus()).toEqual({ status: 'maintenance' });
  });

  it('fetches images from wdgzone.tech only, never sending the key', async () => {
    const calls: { url: string; headers: RequestInit['headers'] }[] = [];
    const wdg = new WdgzoneAdapter({
      apiKey: API_KEY,
      fetch: async (input, init) => {
        calls.push({ url: String(input), headers: init?.headers });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });
    const limits = { maxBytes: 10, timeoutMs: 1_000 };
    expect(wdg.imageHosts).toEqual(['wdgzone.tech']);
    expect(await wdg.fetchImage('https://wdgzone.tech/panel/a.png', limits)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(API_KEY);
    await expect(wdg.fetchImage('https://evil.test/a.png', limits)).rejects.toMatchObject({
      kind: 'definitive',
    });
  });
});
