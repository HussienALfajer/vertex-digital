import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupplierError } from '../core/errors.js';
import { type FakeHttpServer, startFakeHttpServer } from '../testing/fake-http-server.js';
import { ZddkAdapter, zddkOrderUuid } from './adapter.js';
import { decimalOf, usdUnitsOf } from './decimal.js';

/*
 * The zddk adapter (jneedcontur) against the local fake server. The fixtures follow the examples of
 * the store's public documentation (`api-docs`, 2026-11-05) with the section's products as the
 * owner's account showed them on 2026-11-04 (docs/suppliers/jneedcontur.md, "Fixtures"); ids,
 * numbers and texts are made up. No live reply was recorded: nothing here calls jneedcontur.
 */

const TOKEN = 'jnc_test_token_for_fixtures_only';
const ATTEMPT_ID = '0190f1c2-7a3b-7c4d-8e5f-0123456789ab';
/** ZD5: the order key derived from `ATTEMPT_ID`, fixed so a change of the derivation shows. */
const ORDER_UUID = '83287453-bf81-4a07-9bcb-edd870f01151';
const LINE = '0940000000';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

let server: FakeHttpServer;

const adapter = (options: { timeoutMs?: number; baseUrl?: string } = {}) =>
  new ZddkAdapter({
    store: 'jneedcontur',
    apiToken: TOKEN,
    baseUrl: options.baseUrl ?? `${server.url}/client/api/`,
    // Generous: a busy CI runner must not turn an ordinary reply into a timeout.
    timeoutMs: options.timeoutMs ?? 5_000,
  });

const sentSince = (count: number) => server.requests.slice(count);

const order = (overrides: Partial<Parameters<ZddkAdapter['placeOrder']>[0]> = {}) => ({
  idempotencyKey: ATTEMPT_ID,
  offerId: '1520:1000',
  quantity: 1,
  fields: { playerId: LINE },
  ...overrides,
});

beforeAll(async () => {
  server = await startFakeHttpServer();
});

afterAll(() => server.close());

describe('ZddkAdapter shape (S25 ZD1, ZD2)', () => {
  it('reads the catalog, balance and quotes; no player check, webhook or statement', async () => {
    const zddk = adapter();
    expect(zddk.code).toBe('jneedcontur');
    expect(zddk.capabilities).toEqual({
      validatePlayer: false,
      webhooks: false,
      balance: true,
      catalog: true,
      categories: true,
      statement: false,
      platformStatus: false,
      offerQuote: true,
      offerWindow: false,
      account: false,
    });
    expect(zddk.imageHosts).toEqual(['api.jneedcontur.net']);
    // The store's webhook is unsigned: never accepted, whatever it carries.
    expect(zddk.verifyWebhook()).toBe(false);
    expect(() => zddk.parseWebhook()).toThrow(SupplierError);
    for (const call of [
      () => zddk.validatePlayer(),
      () => zddk.listCheckCategories(),
      () => zddk.listTransactions(),
      () => zddk.listOrders(),
      () => zddk.getPlatformStatus(),
      () => zddk.listOffersIn(),
      () => zddk.getAccount(),
      () => zddk.getWebhook(),
      () => zddk.setWebhook(),
      () => zddk.testWebhook(),
    ]) {
      await expect(call()).rejects.toMatchObject({ kind: 'definitive' });
    }
  });
});

describe('ZddkAdapter catalog (ZD3, ZD4)', () => {
  it('lists packages, one offer per listed value and one @100 offer per range, costs exact', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('products') });
    const offers = await adapter().listOffers();
    const [request] = sentSince(before);
    expect(request?.path).toBe('/client/api/products');
    expect(request?.headers['api-token']).toBe(TOKEN);
    expect(offers.map((offer) => offer.offerId)).toEqual([
      '1520:1000',
      '1520:5000',
      '1520:7200',
      '1477:96.15',
      '1477:1000',
      '2049@100',
      '1995@100',
      '18',
      '400',
      '500',
    ]);
    const line = [{ key: 'playerId', label: 'رقم الخط', type: 'text' }];
    expect(offers[0]).toEqual({
      offerId: '1520:1000',
      name: 'MTN · 1000',
      cost: { currency: 'USD', amountUnits: 7_437_500 },
      originalCost: { currency: 'USD', amountUnits: 7_000_000 },
      inStock: true,
      kind: 'direct',
      // One value a time: RT4 skips the route for a product sold several at once.
      minQuantity: 1,
      maxQuantity: 1,
      group: 'الرصيد والفواتير',
      categoryId: 'category.229',
      requiredFields: ['playerId'],
      fieldSpecs: line,
    });
    // A value written as a number reads the same as a string.
    expect(offers[2]?.cost.amountUnits).toBe(53_550_000);
    // ×96.15 leaves a fraction of a micro-dollar: kept, never sold, the cost shown rounded up.
    expect(offers[3]).toMatchObject({
      unsupportedReason: 'cost_precision',
      cost: { currency: 'USD', amountUnits: 725_510 },
      originalCost: { currency: 'USD', amountUnits: 692_280 },
    });
    expect(offers[4]).toMatchObject({ cost: { amountUnits: 7_545_600 } });
    expect(offers[4]).not.toHaveProperty('unsupportedReason');
    // A range: one unit is 100 SYP, the bounds in units of 100.
    expect(offers[5]).toEqual({
      offerId: '2049@100',
      name: 'فواتير MTN',
      cost: { currency: 'USD', amountUnits: 723_240 },
      originalCost: { currency: 'USD', amountUnits: 690_000 },
      inStock: true,
      kind: 'amount',
      minQuantity: 1,
      maxQuantity: 1_000,
      group: 'الرصيد والفواتير',
      categoryId: 'category.229',
      requiredFields: ['playerId'],
      fieldSpecs: [{ key: 'playerId', label: 'ID', type: 'text' }],
    });
    expect(offers[6]).toMatchObject({
      inStock: false,
      kind: 'amount',
      minQuantity: 100,
      maxQuantity: 10_000,
      unsupportedReason: 'cost_precision',
      cost: { amountUnits: 9_041 },
    });
    expect(offers[7]).toMatchObject({
      name: 'UC 60',
      cost: { currency: 'USD', amountUnits: 1_094_000 },
      originalCost: { currency: 'USD', amountUnits: 877_000 },
      kind: 'direct',
      minQuantity: 1,
      maxQuantity: 1,
      group: 'PUBG Global ID UC',
      categoryId: 'category.7',
      requiredFields: ['playerId'],
    });
    expect(offers[7]).not.toHaveProperty('unsupportedReason');
    // Q31: two fields, or none (perhaps a code product), are not sold until the supplier answers.
    expect(offers[8]).toMatchObject({
      unsupportedReason: 'fields_unsupported',
      requiredFields: [],
      fieldSpecs: [],
    });
    expect(offers[9]).toMatchObject({ unsupportedReason: 'fields_unsupported' });
    expect(offers[9]).not.toHaveProperty('categoryId');
  });

  it('lists the categories the products are in, with images on the store host only', async () => {
    server.reply({ body: fixture('products') });
    expect(await adapter().listCategories()).toEqual([
      {
        categoryId: 'category.229',
        name: 'الرصيد والفواتير',
        productCount: 4,
        inStockCount: 3,
        imageUrl: 'https://api.jneedcontur.net/images/category/1700000001.webp',
      },
      {
        categoryId: 'category.7',
        name: 'PUBG Global ID UC',
        productCount: 1,
        inStockCount: 1,
        imageUrl: 'https://api.jneedcontur.net/images/category/1710948113.webp',
      },
      // Its image is on another host: left out (IM1).
      { categoryId: 'category.31', name: 'Mobile Legends', productCount: 1, inStockCount: 1 },
    ]);
  });

  it('leaves out an image path that climbs out or is not a path', async () => {
    const product = (category_img: string) => ({
      ...(fixture('products') as Record<string, unknown>[])[4],
      category_img,
    });
    server.reply({
      body: [
        product('../secrets/x.webp'),
        product('images/../x.webp'),
        product('https://api.jneedcontur.net:8443/x.webp'),
      ],
    });
    const [category] = await adapter().listCategories();
    expect(category).not.toHaveProperty('imageUrl');
  });

  it('keeps no offer whose range cannot hold one unit, or whose price is not a number', async () => {
    const base = (fixture('products') as Record<string, unknown>[])[2] as Record<string, unknown>;
    server.reply({
      body: [
        { ...base, id: 1, qty_values: { min: 'x', max: 100 } },
        { ...base, id: 2, qty_values: { min: 500, max: 100 } },
        // No whole unit of 100 fits: never an unbounded route (AM3).
        { ...base, id: 5, qty_values: { min: 10, max: 50 } },
        { ...base, id: 6, qty_values: { min: 150, max: 180 } },
        { ...base, id: 3, price: 'free' },
        { ...base, id: 4, price: -1 },
      ],
    });
    expect(await adapter().listOffers()).toEqual([]);
  });

  it('caps an amount offer at a million units, which the sync keeps', async () => {
    const base = (fixture('products') as Record<string, unknown>[])[2] as Record<string, unknown>;
    server.reply({ body: [{ ...base, qty_values: { min: 100, max: 900_000_000 } }] });
    expect(await adapter().listOffers()).toMatchObject([
      { offerId: '2049@100', minQuantity: 1, maxQuantity: 1_000_000 },
    ]);
  });

  it('throws a retryable error on a catalog reply that is not a list', async () => {
    server.reply({ body: { status: 'ERROR', code: 121 } });
    await expect(adapter().listOffers()).rejects.toMatchObject({
      kind: 'retryable',
      details: { failure: 'unreadable' },
    });
  });
});

describe('ZddkAdapter balance and quote (ZD9, S18 PQ1)', () => {
  it('reads the balance as exact USD units', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('profile') });
    expect(await adapter().getBalance()).toEqual({ currency: 'USD', amountUnits: 25_437_500 });
    expect(sentSince(before)[0]?.path).toBe('/client/api/profile');
  });

  it('refuses a balance with more than six decimals', async () => {
    server.reply({ body: { balance: '1.1234567' } });
    await expect(adapter().getBalance()).rejects.toMatchObject({ kind: 'retryable' });
  });

  it("quotes one offer from its product's current row", async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('products') });
    expect(await adapter().getOfferQuote('1520:5000')).toEqual({
      cost: { currency: 'USD', amountUnits: 37_187_500 },
      inStock: true,
    });
    expect(sentSince(before)[0]?.path).toBe('/client/api/products?products_id=1520');
    // A cost that is not exact is never quoted: the send waits for the next sync.
    await expect(adapter().getOfferQuote('1995@100')).rejects.toMatchObject({ kind: 'retryable' });
  });

  it('refuses a quote for an offer the supplier no longer lists, or not of its shape', async () => {
    server.reply({ body: fixture('products') });
    await expect(adapter().getOfferQuote('1520:42')).rejects.toMatchObject({
      kind: 'definitive',
      details: { supplierCode: 'PRODUCT_NOT_FOUND' },
    });
    const before = server.requests.length;
    await expect(adapter().getOfferQuote('topup:x:1')).rejects.toMatchObject({
      kind: 'definitive',
    });
    expect(sentSince(before)).toEqual([]);
  });
});

describe('ZddkAdapter orders (ZD5, ZD6)', () => {
  it('derives a fixed version-4 order key from the attempt id', () => {
    expect(zddkOrderUuid(ATTEMPT_ID)).toBe(ORDER_UUID);
    expect(zddkOrderUuid(ATTEMPT_ID)).toBe(zddkOrderUuid(ATTEMPT_ID));
    expect(zddkOrderUuid(`${ATTEMPT_ID}-2`)).not.toBe(ORDER_UUID);
    for (const key of [ATTEMPT_ID, 'a', '0190f1c2-7a3b-7c4d-8e5f-000000000000']) {
      expect(zddkOrderUuid(key)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('sends a listed value with the line and the derived key, delivered with its reference', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('new-order-accept') });
    expect(await adapter().placeOrder(order())).toEqual({
      status: 'delivered',
      supplierOrderId: 'ID_0000aaaa1111bbbb',
      quantity: 1,
      chargedUsdUnits: 7_437_500,
      reference: 'OP-0001',
    });
    const [request] = sentSince(before);
    expect(request?.method).toBe('GET');
    expect(request?.path).toBe(
      `/client/api/newOrder/1520/params?qty=1000&playerId=${LINE}&order_uuid=${ORDER_UUID}`,
    );
    expect(request?.headers['api-token']).toBe(TOKEN);
  });

  it('sends an amount as quantity × 100, pending while the supplier waits', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('new-order-wait') });
    // No charge read for an amount until the pilot shows what its `price` is.
    expect(await adapter().placeOrder(order({ offerId: '2049@100', quantity: 73 }))).toEqual({
      status: 'pending',
      supplierOrderId: 'ID_0000aaaa2222cccc',
    });
    expect(sentSince(before)[0]?.path).toBe(
      `/client/api/newOrder/2049/params?qty=7300&playerId=${LINE}&order_uuid=${ORDER_UUID}`,
    );
  });

  it('sends a package as one unit; a rejection is definitive', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('new-order-reject') });
    expect(
      await adapter().placeOrder(order({ offerId: '18', fields: { playerId: '5000000001' } })),
    ).toEqual({
      status: 'failed_definitive',
      supplierOrderId: 'ID_0000aaaa3333dddd',
      supplierCode: 'reject',
      reason: 'Rejected by jneedcontur',
    });
    expect(sentSince(before)[0]?.path).toMatch(/^\/client\/api\/newOrder\/18\/params\?qty=1&/);
  });

  it('sends a repeat with the same key, so the supplier answers the first order', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('new-order-accept') });
    const first = await adapter().placeOrder(order());
    const again = await adapter().placeOrder({ ...order(), resend: true });
    expect(again).toEqual(first);
    const keys = sentSince(before).map((request) =>
      new URL(request.path, server.url).searchParams.get('order_uuid'),
    );
    expect(keys).toEqual([ORDER_UUID, ORDER_UUID]);
  });

  it('sends an order without a field when the offer takes none', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('new-order-accept') });
    await adapter().placeOrder(order({ offerId: '18', fields: {} }));
    expect(sentSince(before)[0]?.path).toBe(
      `/client/api/newOrder/18/params?qty=1&order_uuid=${ORDER_UUID}`,
    );
  });

  it('refuses before sending: another offer id, units the offer cannot take, other fields', async () => {
    const before = server.requests.length;
    for (const [request, code] of [
      [order({ offerId: 'topup:x:1' }), 'PRODUCT_NOT_FOUND'],
      [order({ offerId: '1520:1e3' }), 'PRODUCT_NOT_FOUND'],
      [order({ offerId: '18', quantity: 2 }), 'QUANTITY_UNSUPPORTED'],
      [order({ quantity: 2 }), 'QUANTITY_UNSUPPORTED'],
      [order({ offerId: '2049@100', quantity: 0 }), 'QUANTITY_UNSUPPORTED'],
      [order({ offerId: '2049@100', quantity: 1.5 }), 'QUANTITY_UNSUPPORTED'],
      [order({ offerId: '2049@100', quantity: 20_000_000 }), 'QUANTITY_UNSUPPORTED'],
      [order({ fields: { playerId: LINE, zone: '1' } }), 'FIELDS_UNSUPPORTED'],
      [order({ fields: { playerId: '  ' } }), 'FIELDS_UNSUPPORTED'],
      [order({ fields: { playerId: 'x'.repeat(129) } }), 'FIELDS_UNSUPPORTED'],
    ] as const) {
      expect(await adapter().placeOrder(request)).toMatchObject({
        status: 'failed_definitive',
        supplierCode: code,
      });
    }
    expect(sentSince(before)).toEqual([]);
  });

  it('answers unknown, never failed, for any reply outside the success shape (Q32)', async () => {
    const replies = [
      [{ status: 500, body: { message: 'Server Error' } }, 'http_5xx'],
      // Q32: the error reply is undocumented, so even a documented code is not trusted yet.
      [
        { status: 400, body: { status: 'ERROR', code: 100, message: 'Insufficient balance' } },
        'http_4xx',
      ],
      [{ status: 200, body: { status: 'ERROR', code: 111 } }, 'unreadable'],
      [{ status: 200, body: 'not json' }, 'unreadable'],
      [{ status: 429, body: {} }, 'rate_limited'],
    ] as const;
    for (const [reply, failure] of replies) {
      server.reply(reply);
      expect(await adapter().placeOrder(order())).toMatchObject({ status: 'unknown', failure });
    }
  });

  it('answers unknown for a status it does not know, or an order id it cannot keep', async () => {
    const accept = fixture('new-order-accept') as { data: Record<string, unknown> };
    server.reply({ body: { ...accept, data: { ...accept.data, status: 'processing' } } });
    expect(await adapter().placeOrder(order())).toMatchObject({
      status: 'unknown',
      supplierOrderId: 'ID_0000aaaa1111bbbb',
      answered: true,
    });
    server.reply({ body: { ...accept, data: { ...accept.data, order_id: 'ID 1/../x' } } });
    expect(await adapter().placeOrder(order())).toMatchObject({
      status: 'unknown',
      answered: true,
    });
  });

  it('answers unknown on a timeout after sending, and on a refused connection', async () => {
    server.reply({ body: fixture('new-order-accept'), delayMs: 300 });
    expect(await adapter({ timeoutMs: 50 }).placeOrder(order())).toMatchObject({
      status: 'unknown',
      failure: 'timeout',
    });
    expect(
      await adapter({ baseUrl: 'http://127.0.0.1:1/client/api/' }).placeOrder(order()),
    ).toMatchObject({ status: 'unknown' });
  });

  it('keeps no charge it cannot read exactly, and reads the reference of either shape', async () => {
    const accept = fixture('new-order-accept') as { data: Record<string, unknown> };
    server.reply({
      body: {
        ...accept,
        data: {
          ...accept.data,
          price: 1.1234567,
          replay_api: ['OP-1', { replay: ['\u0007OP-2'] }],
        },
      },
    });
    const outcome = await adapter().placeOrder(order());
    expect(outcome).toMatchObject({ status: 'delivered', reference: 'OP-1 · OP-2' });
    expect(outcome).not.toHaveProperty('chargedUsdUnits');
    server.reply({ body: { ...accept, data: { ...accept.data, replay_api: [[], ' '] } } });
    expect(await adapter().placeOrder(order())).not.toHaveProperty('reference');
  });
});

describe('ZddkAdapter polling (ZD7)', () => {
  it('reads an order by its key, with the units asked, the charge and the reference', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('check-accept') });
    // An amount order (several units): its charge is not read yet.
    expect(
      await adapter().getOrder(ATTEMPT_ID, {
        supplierOrderId: 'ID_0000aaaa2222cccc',
        quantity: 73,
      }),
    ).toEqual({
      status: 'delivered',
      supplierOrderId: 'ID_0000aaaa2222cccc',
      quantity: 73,
      reference: 'OP-0002',
    });
    server.reply({ body: fixture('check-accept') });
    expect(await adapter().getOrder(ATTEMPT_ID, { quantity: 1 })).toMatchObject({
      status: 'delivered',
      chargedUsdUnits: 72_324_000,
    });
    expect(sentSince(before)[0]?.path).toBe(`/client/api/check?orders=[${ORDER_UUID}]&uuid=1`);
  });

  it('answers unknown, answered, for a key the supplier does not know (Q34)', async () => {
    server.reply({ body: fixture('check-empty') });
    expect(await adapter().getOrder(ATTEMPT_ID, { quantity: 1 })).toEqual({
      status: 'unknown',
      reason: 'jneedcontur knows no order with this key',
      answered: true,
    });
    server.reply({ body: fixture('check-empty') });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ID_1', quantity: 1 }),
    ).toMatchObject({ status: 'unknown', supplierOrderId: 'ID_1', answered: true });
  });

  it('answers unknown for several orders under one key, or without the units to settle', async () => {
    const check = fixture('check-accept') as { status: string; data: unknown[] };
    server.reply({ body: { ...check, data: [check.data[0], check.data[0]] } });
    expect(await adapter().getOrder(ATTEMPT_ID, { quantity: 1 })).toMatchObject({
      status: 'unknown',
      answered: true,
    });
    server.reply({ body: check });
    expect(await adapter().getOrder(ATTEMPT_ID)).toMatchObject({
      status: 'unknown',
      answered: true,
    });
  });

  it('answers unknown, not answered, when the poll gets no readable reply', async () => {
    server.reply({ status: 502, body: {} });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ID_1', quantity: 1 }),
    ).toMatchObject({ status: 'unknown', failure: 'http_5xx', supplierOrderId: 'ID_1' });
    server.reply({ status: 404, body: { status: 'ERROR' } });
    const missing = await adapter().getOrder(ATTEMPT_ID, { quantity: 1 });
    expect(missing).toMatchObject({ status: 'unknown', failure: 'http_4xx' });
    expect(missing).not.toHaveProperty('answered');
  });

  it('reads wait and reject from the poll as from the order', async () => {
    const check = fixture('check-accept') as { status: string; data: Record<string, unknown>[] };
    const row = check.data[0] as Record<string, unknown>;
    server.reply({ body: { ...check, data: [{ ...row, status: 'wait' }] } });
    expect(await adapter().getOrder(ATTEMPT_ID, { quantity: 1 })).toMatchObject({
      status: 'pending',
      chargedUsdUnits: 72_324_000,
    });
    server.reply({ body: { ...check, data: [{ ...row, status: 'reject' }] } });
    expect(await adapter().getOrder(ATTEMPT_ID, { quantity: 73 })).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'reject',
    });
  });
});

describe('zddk amounts (ZD4, ADR 0003)', () => {
  it('reads decimals exactly, in plain and exponent notation', () => {
    expect(decimalOf('1.2604800000000000')).toEqual({ digits: 12604800000000000n, scale: 16 });
    expect(decimalOf(1e-7)).toEqual({ digits: 1n, scale: 7 });
    expect(decimalOf('2.5E+3')).toEqual({ digits: 2500n, scale: 0 });
    for (const bad of [-1, '-1', '', '1,5', 'NaN', Number.POSITIVE_INFINITY, '0x10']) {
      expect(decimalOf(bad)).toBeNull();
    }
  });

  it('multiplies without floating point, refusing a fraction of a micro-dollar', () => {
    expect(usdUnitsOf('1.2604800000000000')).toBe(1_260_480);
    expect(usdUnitsOf(0.1, 3)).toBe(300_000);
    expect(usdUnitsOf(1e-7, 100)).toBe(10);
    expect(usdUnitsOf(0.0075456, '96.15')).toBeNull();
    expect(usdUnitsOf(0.0075456, '96.15', { roundUp: true })).toBe(725_510);
    expect(usdUnitsOf('0.0000001')).toBeNull();
    expect(usdUnitsOf('0.0000001', 1, { roundUp: true })).toBe(1);
    expect(usdUnitsOf(0)).toBe(0);
    expect(usdUnitsOf('999999999999999', 1000)).toBeNull();
    expect(usdUnitsOf(1, 'x')).toBeNull();
  });
});
