import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SupplierError } from '../core/errors.js';
import { hmacSha256 } from '../core/hmac.js';
import { type FakeHttpServer, startFakeHttpServer } from '../testing/fake-http-server.js';
import { FazercardsAdapter, FZR_SIGNATURE_HEADER } from './adapter.js';

/*
 * The FazerCards adapter against the local fake server. Catalog, account, webhook settings and
 * player-check replies were recorded read-only from the live API on 2026-10-20 and sanitized;
 * order, statement and webhook bodies follow its OpenAPI document and SDK, since the account had no
 * order yet (docs/suppliers/fazercards.md, "Fixtures"). Nothing here calls FazerCards.
 */

const API_KEY = 'fzr_test_key_for_fixtures_only';
const SECRET = 'fzr_test_webhook_secret';
const NOW = new Date('2026-10-20T09:05:00Z');
const ATTEMPT_ID = '0190f1c2-7a3b-7c4d-8e5f-0123456789ab';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

let server: FakeHttpServer;
let sleeps: number[];
let clock: number;

const adapter = (options: { timeoutMs?: number } = {}) =>
  new FazercardsAdapter({
    apiKey: API_KEY,
    webhookSecret: SECRET,
    baseUrl: `${server.url}/api/v2/`,
    // Generous: a busy CI runner must not turn an ordinary reply into a timeout.
    timeoutMs: options.timeoutMs ?? 5_000,
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

const sentSince = (count: number) => server.requests.slice(count);

beforeAll(async () => {
  server = await startFakeHttpServer();
});

afterAll(() => server.close());

beforeEach(() => {
  sleeps = [];
  clock = NOW.getTime();
});

describe('FazercardsAdapter catalog (FC3, FC4)', () => {
  it('lists top-up then gift-card categories, gift cards by cursor, flat with images and notes', async () => {
    const before = server.requests.length;
    server.reply(
      { body: fixture('topups') },
      { body: fixture('giftcards-page-1') },
      { body: fixture('giftcards-page-2') },
    );
    const categories = await adapter().listCategories();
    const paths = sentSince(before).map((request) => request.path);
    expect(paths[0]).toBe('/api/v2/topups?limit=500&include_ui=1');
    expect(paths[1]).toBe('/api/v2/giftcards?limit=200&include_ui=1');
    expect(paths[2]).toMatch(/^\/api\/v2\/giftcards\?limit=200&include_ui=1&cursor=eyJ/);
    expect(sentSince(before)[0]?.headers['x-api-key']).toBe(API_KEY);
    expect(categories.find((c) => c.categoryId === 'topup.pubg_mobile_auto')).toEqual({
      categoryId: 'topup.pubg_mobile_auto',
      name: 'PUBG Mobile (Auto)',
      kind: 'direct',
      imageUrl: expect.stringMatching(/^https:\/\/reseller\.fazercards\.com\/api\/v2\/media\//),
      note: expect.stringMatching(/^Region: Global\n/),
    });
    expect(categories.find((c) => c.categoryId === 'gift.acash_my')).toMatchObject({
      kind: 'code',
      imageUrl: expect.stringMatching(/\.webp$/),
      note: expect.stringMatching(/^Region: MY/),
    });
    // Page 2 of the gift cards carries no images.
    expect(
      categories.find((c) => c.categoryId === 'gift.netease_pay_ngn')?.imageUrl,
    ).toBeUndefined();
    expect(categories.filter((c) => c.parentCategoryId !== undefined)).toEqual([]);
    expect(categories).toHaveLength(6 + 3 + 2);
    // FC1: catalog reads 600 ms apart.
    expect(sleeps.every((ms) => ms <= 600)).toBe(true);
  });

  it('drops a category whose image is on another host or whose id is not FazerCards-shaped', async () => {
    server.reply(
      {
        body: {
          ok: true,
          items: [
            { category_id: 'ok_one', name: 'Ok', imageurl: 'https://evil.example/x.png' },
            { category_id: 'bad id!', name: 'Bad' },
            { category_id: 'nameless', name: '   ' },
            'not an object',
          ],
          meta: { has_more: false },
        },
      },
      { body: { ok: true, items: [], meta: { has_more: true, next_cursor: 'x' } } },
    );
    const categories = await adapter().listCategories();
    expect(categories).toEqual([{ categoryId: 'topup.ok_one', name: 'Ok', kind: 'direct' }]);
  });

  it('reads the offers of the categories asked, with fields, exact costs and composite ids', async () => {
    const before = server.requests.length;
    server.reply(
      { body: fixture('topup-offers-pubg-auto') },
      { body: fixture('gift-cards-acash') },
    );
    const { offers, readCategoryIds } = await adapter().listOffersIn([
      'topup.pubg_mobile_auto',
      'gift.acash_my',
      'not-a-category',
    ]);
    expect(sentSince(before).map((request) => request.path)).toEqual([
      '/api/v2/topups/offers?category_id=pubg_mobile_auto',
      '/api/v2/giftcards/cards?category_id=acash_my',
    ]);
    expect(readCategoryIds).toEqual(['topup.pubg_mobile_auto', 'gift.acash_my']);
    expect(offers[0]).toEqual({
      offerId: 'topup:pubg_mobile_auto:60_uc',
      name: '60 UC',
      cost: { currency: 'USD', amountUnits: 875_000 },
      inStock: true,
      group: 'PUBG Mobile (Auto)',
      kind: 'direct',
      requiredFields: ['player_id'],
      categoryId: 'topup.pubg_mobile_auto',
      fieldSpecs: [{ key: 'player_id', label: 'Player ID', type: 'text' }],
    });
    // Four decimals, exactly: 43.9439 is 43,943,900 micro-dollars.
    expect(
      offers.find((o) => o.offerId === 'topup:pubg_mobile_auto:3850_uc')?.cost.amountUnits,
    ).toBe(43_943_900);
    expect(offers.find((o) => o.offerId === 'gift:acash_my:10_myr')).toEqual({
      offerId: 'gift:acash_my:10_myr',
      name: '10 MYR',
      cost: { currency: 'USD', amountUnits: 2_600_000 },
      inStock: true,
      group: 'A-Cash (MY)',
      kind: 'code',
      requiredFields: [],
      categoryId: 'gift.acash_my',
      stock: 100,
      minQuantity: 1,
      maxQuantity: 100,
      fieldSpecs: [],
    });
  });

  it('keeps Manual and login categories unsupported, and two-field games sendable', async () => {
    server.reply(
      { body: fixture('topup-offers-pubg-manual') },
      { body: fixture('topup-offers-genshin-login') },
      { body: fixture('topup-offers-arknight-login') },
      { body: fixture('topup-offers-ml-adventure') },
    );
    const { offers } = await adapter().listOffersIn([
      'topup.pubg_mobile_manual',
      'topup.genshin_impact_login',
      'topup.arknight_endfield_login',
      'topup.mobile_legends_adventure',
    ]);
    const reason = (category: string) =>
      new Set(offers.filter((o) => o.categoryId === category).map((o) => o.unsupportedReason));
    expect(reason('topup.pubg_mobile_manual')).toEqual(new Set(['manual_delivery']));
    expect(reason('topup.genshin_impact_login')).toEqual(new Set(['fields_unsupported']));
    expect(reason('topup.arknight_endfield_login')).toEqual(new Set(['fields_unsupported']));
    expect(reason('topup.mobile_legends_adventure')).toEqual(new Set([undefined]));
    expect(
      offers.find((o) => o.categoryId === 'topup.arknight_endfield_login')?.fieldSpecs?.[2],
    ).toMatchObject({ key: 'server', type: 'select', options: [{ value: 'Asia' }, {}, {}] });
  });

  it('marks a select outside the bounds, an unknown type or too many fields unsupported', async () => {
    const offersReply = (fields: unknown[]) => ({
      body: {
        ok: true,
        category_id: 'game',
        name: 'Game',
        offers: [{ offer_id: 'a', name: 'A', price_usd: '1.0000' }],
        fields,
      },
    });
    server.reply(
      offersReply([{ key: 'server', type: 'select', options: [{ value: 'only' }] }]),
      offersReply([{ key: 'player_id', type: 'number' }]),
      offersReply(Array.from({ length: 11 }, (_, i) => ({ key: `f${i}` }))),
      offersReply([{ key: 'bad key!' }]),
    );
    const window = adapter();
    for (const _ of [1, 2, 3, 4]) {
      const { offers } = await window.listOffersIn(['topup.game']);
      expect(offers[0]?.unsupportedReason).toBe('fields_unsupported');
    }
  });

  it('drops offers it cannot read and costs that are not exact', async () => {
    server.reply({
      body: {
        ok: true,
        category_id: 'game',
        offers: [
          { offer_id: 'a', name: 'A', price_usd: '1.12345678' },
          { offer_id: 'has:colon', name: 'B', price_usd: '1.0000' },
          { name: 'no id', price_usd: '1.0000' },
          { offer_id: 'c', name: 'C', price_usd: 2.5 },
        ],
      },
    });
    const { offers } = await adapter().listOffersIn(['topup.game']);
    expect(offers.map((o) => [o.offerId, o.cost.amountUnits, o.group])).toEqual([
      ['topup:game:c', 2_500_000, 'game'],
    ]);
  });

  it('reads gift cards out of stock and with unknown stock', async () => {
    server.reply({
      body: {
        ok: true,
        category_id: 'g',
        name: 'G',
        offers: [
          { card_id: 'zero', name: 'Zero', price_usd: '1.0000', stock: 0 },
          { card_id: 'open', name: 'Open', price_usd: '1.0000' },
          { card_id: 'bad', name: 'Bad', price_usd: 'free' },
          { name: 'no id', price_usd: '1.0000' },
        ],
      },
    });
    const { offers } = await adapter().listOffersIn(['gift.g']);
    expect(offers.map((o) => [o.offerId, o.inStock, o.stock])).toEqual([
      ['gift:g:zero', false, 0],
      ['gift:g:open', true, undefined],
    ]);
  });

  it('reads a category FazerCards no longer knows as empty, and skips one that fails', async () => {
    server.reply(
      { status: 404, body: fixture('error-category') },
      { status: 500, body: { ok: false, error: 'boom' } },
      { body: fixture('topup-offers-free-fire') },
    );
    const { offers, readCategoryIds } = await adapter().listOffersIn([
      'topup.gone',
      'topup.broken',
      'topup.free_fire_mena',
    ]);
    expect(readCategoryIds).toEqual(['topup.gone', 'topup.free_fire_mena']);
    expect(new Set(offers.map((o) => o.categoryId))).toEqual(new Set(['topup.free_fire_mena']));
  });

  it("counts a 404 as empty only in FazerCards' words (audit A05-19)", async () => {
    server.reply(
      { status: 404, body: '<html>Not Found</html>' },
      { body: fixture('topup-offers-free-fire') },
    );
    const { readCategoryIds } = await adapter().listOffersIn([
      'topup.gone',
      'topup.free_fire_mena',
    ]);
    expect(readCategoryIds).toEqual(['topup.free_fire_mena']);
  });

  it('stops at the first category refused for the plan (audit A05-14)', async () => {
    const before = server.requests.length;
    server.reply({
      status: 403,
      body: { ok: false, error: 'Subscription inactive', code: 'subscription_inactive' },
    });
    await expect(adapter().listOffersIn(['topup.a', 'topup.b', 'topup.c'])).rejects.toMatchObject({
      details: { status: 403, supplierCode: 'subscription_inactive' },
    });
    expect(server.requests.length - before).toBe(1);
  });

  it('throws when every category failed, and answers nothing for no category', async () => {
    server.reply({ status: 503, body: { ok: false } });
    await expect(adapter().listOffersIn(['topup.a', 'topup.b'])).rejects.toBeInstanceOf(
      SupplierError,
    );
    expect(await adapter().listOffersIn([])).toEqual({ offers: [], readCategoryIds: [] });
    await expect(adapter().listOffers()).rejects.toMatchObject({ kind: 'definitive' });
  });

  it('waits out a 429 once on a read, then gives up', async () => {
    server.reply(
      { status: 429, headers: { 'retry-after': '7' }, body: { ok: false } },
      { body: fixture('topup-offers-free-fire') },
    );
    const { readCategoryIds } = await adapter().listOffersIn(['topup.free_fire_mena']);
    expect(readCategoryIds).toEqual(['topup.free_fire_mena']);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(7_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(61_000);

    server.reply({ status: 429, headers: { 'retry-after': '1' }, body: { ok: false } });
    await expect(adapter().listCategories()).rejects.toMatchObject({
      details: { failure: 'rate_limited' },
    });
  });

  it('pauses when few requests are left in the window', async () => {
    server.reply({
      headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '20' },
      body: fixture('topup-offers-free-fire'),
    });
    await adapter().listOffersIn(['topup.free_fire_mena']);
    expect(sleeps).toContain(21_000);
  });

  it('refuses a catalog larger than expected', async () => {
    server.reply({
      body: {
        ok: true,
        items: [{ category_id: 'a', name: 'A' }],
        meta: { has_more: true, next_cursor: 'n' },
      },
    });
    await expect(adapter().listCategories()).rejects.toThrow(/larger than expected/);
  });
});

describe('FazercardsAdapter account (FC8, FC9)', () => {
  it('reads the balance exactly in USD', async () => {
    server.reply({ body: { ok: true, balance: '12.3456', currency: 'USD' } });
    expect(await adapter().getBalance()).toEqual({ currency: 'USD', amountUnits: 12_345_600 });
    server.reply({ body: fixture('balance') });
    expect(await adapter().getBalance()).toEqual({ currency: 'USD', amountUnits: 0 });
    server.reply({ body: { ok: true, balance: '1.0000', currency: 'EUR' } });
    await expect(adapter().getBalance()).rejects.toThrow(/unexpected amount or currency/);
  });

  it('reads the plan from /me, never the login', async () => {
    server.reply({ body: fixture('me') });
    expect(await adapter().getAccount()).toEqual({
      plan: 'trial',
      active: true,
      expiresAt: new Date('2026-10-24T21:33:21.869Z'),
      autoRenew: false,
    });
    server.reply({ body: { ok: true, plan: 'bronze', subscriptionActive: false } });
    expect(await adapter().getAccount()).toEqual({ plan: 'bronze', active: false });
  });

  it('reads the webhook settings and its delivery log, without the secret', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('webhook') }, { body: fixture('webhook-deliveries') });
    const { state, deliveries } = await adapter().getWebhook();
    expect(sentSince(before).map((r) => r.path)).toEqual([
      '/api/v2/account/webhook',
      '/api/v2/account/webhook/deliveries',
    ]);
    expect(state).toEqual({
      url: 'https://digital.vertexmedia.pro/api/webhooks/suppliers/fazercards',
      enabled: true,
      consecutiveFailures: 1,
      lastFailureAt: new Date('2026-10-19T21:34:34.806Z'),
      lastFailureReason: 'http_404',
    });
    expect(deliveries).toEqual([
      {
        id: '1000001',
        event: 'webhook.test',
        attempt: 1,
        status: 'failed',
        responseStatus: 404,
        durationMs: 355,
        createdAt: new Date('2026-10-19T21:34:34.806Z'),
      },
    ]);

    server.reply(
      { body: { ok: true, webhook: null } },
      { body: { ok: true, deliveries: ['bad'] } },
    );
    expect(await adapter().getWebhook()).toEqual({ state: { enabled: false }, deliveries: [] });
  });

  it('sets the webhook URL with PUT and asks for its test event', async () => {
    const before = server.requests.length;
    const url = 'https://digital.vertexmedia.pro/api/webhooks/suppliers/fazercards';
    server.reply(
      {
        body: {
          ok: true,
          webhook: {
            url,
            enabled: true,
            consecutive_failures: 0,
            last_success_at: '2026-10-20T09:00:00Z',
          },
        },
      },
      { body: { ok: true } },
    );
    const fazercards = adapter();
    expect(await fazercards.setWebhook(url)).toEqual({
      url,
      enabled: true,
      consecutiveFailures: 0,
      lastSuccessAt: new Date('2026-10-20T09:00:00Z'),
    });
    await fazercards.testWebhook();
    const [put, test] = sentSince(before);
    expect(put).toMatchObject({ method: 'PUT', path: '/api/v2/account/webhook' });
    expect(JSON.parse(put?.body ?? '')).toEqual({ url, enabled: true });
    expect(test).toMatchObject({ method: 'POST', path: '/api/v2/account/webhook/test' });
  });
});

describe('FazercardsAdapter statement (FC10)', () => {
  it('reads transactions with debits negative and their order', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('transactions-page-1') });
    const page = await adapter().listTransactions(1);
    expect(sentSince(before)[0]?.path).toBe('/api/v2/transactions?page=1&limit=50');
    expect(page).toEqual({
      hasMore: false,
      items: [
        {
          id: 'tx-56',
          type: 'debit',
          amount: { currency: 'USD', amountUnits: -875_000 },
          balanceAfter: { currency: 'USD', amountUnits: 9_125_000 },
          reference: 'Order ord-101',
          supplierOrderId: 'ord-101',
          createdAt: new Date('2026-10-20T09:00:00.000Z'),
        },
        {
          id: 'tx-55',
          type: 'credit',
          amount: { currency: 'USD', amountUnits: 10_000_000 },
          balanceAfter: { currency: 'USD', amountUnits: 10_000_000 },
          reference: 'USDT TRC20 deposit',
          createdAt: new Date('2026-10-20T08:00:00.000Z'),
        },
      ],
    });
  });

  it('reads orders with their composite offer id, and pages by total or a full page', async () => {
    server.reply({ body: fixture('orders-page-1') });
    expect((await adapter().listOrders(1)).items).toEqual([
      {
        supplierOrderId: 'ord-101',
        offerId: 'topup:pubg_mobile_auto:60_uc',
        status: 'completed',
        total: { currency: 'USD', amountUnits: 875_000 },
        createdAt: new Date('2026-10-20T09:00:00.000Z'),
        completedAt: new Date('2026-10-20T09:00:02.000Z'),
      },
    ]);
    server.reply({
      body: {
        ok: true,
        items: [
          { id: 'ord-9', card_id: 'c', category_id: 'g', quantity: 2, total_usd: '-1.0000' },
          { bad: 1 },
        ],
        total: 120,
      },
    });
    const gift = await adapter().listOrders(2);
    expect(gift.hasMore).toBe(true);
    expect(gift.items[0]).toEqual({
      supplierOrderId: 'ord-9',
      offerId: 'gift:g:c',
      quantity: 2,
      total: { currency: 'USD', amountUnits: -1_000_000 },
    });
    server.reply({
      body: {
        ok: true,
        items: Array.from({ length: 50 }, (_, i) => ({ id: `tx-${i}`, amount: 'x' })),
      },
    });
    const full = await adapter().listTransactions(1);
    expect(full.hasMore).toBe(true);
    expect(full.items[0]).toEqual({ id: 'tx-0' });
  });

  it('has no platform status, no quote, and images only from its hosts', async () => {
    const fazercards = adapter();
    await expect(fazercards.getPlatformStatus()).rejects.toMatchObject({ kind: 'definitive' });
    await expect(fazercards.getOfferQuote()).rejects.toMatchObject({ kind: 'definitive' });
    await expect(
      fazercards.fetchImage('https://evil.example/a.png', { maxBytes: 10, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(SupplierError);
    expect(fazercards.imageHosts).toEqual(['reseller.fazercards.com', 'api.fzr.cards']);
  });
});

describe('FazercardsAdapter player check (PC2)', () => {
  it('checks on its own check category: found, not found', async () => {
    const before = server.requests.length;
    server.reply({
      body: {
        ok: true,
        category_id: 'pubg_mobile',
        valid: true,
        player_name: ' Player1 ',
        region: 'tr',
      },
    });
    expect(
      await adapter().validatePlayer({
        categoryId: 'pubg_mobile',
        fields: { player_id: '5000000001' },
      }),
    ).toEqual({ valid: true, playerName: 'Player1', region: 'TR' });
    const [sent] = sentSince(before);
    expect(sent).toMatchObject({ method: 'POST', path: '/api/v2/topups/validate-id' });
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      category_id: 'pubg_mobile',
      fields: { player_id: '5000000001' },
    });
    server.reply({ body: fixture('validate-not-found') });
    expect(await adapter().validatePlayer({ categoryId: 'pubg_mobile', fields: {} })).toEqual({
      valid: false,
    });
  });

  it('lists the check categories with their fields (S19 PC1)', async () => {
    const before = server.requests.length;
    const games = fixture('validate-id-games') as { items: unknown[] };
    server.reply({
      body: {
        ...games,
        items: [
          ...games.items,
          { category_id: 'bad id!', name: 'Bad', fields: [] },
          { category_id: 'no_fields' },
          { category_id: 'odd_fields', fields: [{ key: 'bad key!' }] },
        ],
      },
    });
    const categories = await adapter().listCheckCategories();
    expect(categories.map((item) => item.categoryId)).toEqual([
      'pubg_mobile',
      'free_fire',
      'mobile_legends',
      'magic_chess_gogo_global',
      'magic_chess_gogo_ru',
      'no_fields',
    ]);
    expect(categories[2]).toEqual({
      categoryId: 'mobile_legends',
      name: 'Mobile Legends',
      fields: [
        { key: 'player_id', label: 'User ID', type: 'text' },
        { key: 'zone_id', label: 'Zone ID', type: 'text' },
      ],
    });
    expect(categories[5]).toEqual({ categoryId: 'no_fields', name: 'no_fields', fields: [] });
    expect(sentSince(before)[0]).toMatchObject({
      method: 'GET',
      path: '/api/v2/topups/validate-id',
    });
  });

  it('throws without a check category, and on a refusal (the check is then unavailable)', async () => {
    await expect(adapter().validatePlayer({ fields: {} })).rejects.toMatchObject({
      kind: 'definitive',
    });
    server.reply({ status: 400, body: fixture('error-validate-category') });
    await expect(
      adapter().validatePlayer({ categoryId: 'nope', fields: {} }),
    ).rejects.toMatchObject({ kind: 'retryable', details: { status: 400 } });
  });
});

describe('FazercardsAdapter orders (FC5, FC6)', () => {
  const order = (overrides: Partial<Parameters<FazercardsAdapter['placeOrder']>[0]> = {}) => ({
    idempotencyKey: ATTEMPT_ID,
    offerId: 'topup:pubg_mobile_auto:60_uc',
    quantity: 1,
    fields: { player_id: '5000000001' },
    ...overrides,
  });

  it('sends a top-up with the attempt id as Idempotency-Key; processing is pending', async () => {
    const before = server.requests.length;
    server.reply({ status: 201, body: fixture('order-processing') });
    expect(await adapter().placeOrder(order())).toEqual({
      status: 'pending',
      supplierOrderId: 'ord-101',
      chargedUsdUnits: 875_000,
    });
    const [sent] = sentSince(before);
    expect(sent).toMatchObject({ method: 'POST', path: '/api/v2/topups/order' });
    expect(sent?.headers['idempotency-key']).toBe(ATTEMPT_ID);
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      category_id: 'pubg_mobile_auto',
      offer_id: '60_uc',
      fields: { player_id: '5000000001' },
    });
  });

  it('answers a replayed key with the original order, completed', async () => {
    server.reply({ body: fixture('order-completed-topup') });
    expect(await adapter().placeOrder(order({ resend: true }))).toEqual({
      status: 'delivered',
      supplierOrderId: 'ord-101',
      quantity: 1,
      chargedUsdUnits: 875_000,
    });
  });

  it('sends gift cards with a quantity and keeps their codes with pins', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('order-completed-gift') });
    expect(
      await adapter().placeOrder(
        order({ offerId: 'gift:acash_my:10_myr', quantity: 2, fields: {} }),
      ),
    ).toEqual({
      status: 'delivered',
      supplierOrderId: 'ord-102',
      quantity: 2,
      codes: ['TEST-CODE-0001 · PIN: 1111', 'TEST-CODE-0002'],
      chargedUsdUnits: 5_200_000,
    });
    const [sent] = sentSince(before);
    expect(sent?.path).toBe('/api/v2/giftcards/order');
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      category_id: 'acash_my',
      card_id: '10_myr',
      quantity: 2,
    });
  });

  it('keeps gift cards with other units or unreadable codes unknown', async () => {
    server.reply({ body: fixture('order-completed-gift') });
    expect(
      await adapter().placeOrder(
        order({ offerId: 'gift:acash_my:10_myr', quantity: 3, fields: {} }),
      ),
    ).toMatchObject({
      status: 'unknown',
      answered: true,
      reason: 'FazerCards delivered other units',
    });
    server.reply({
      body: { ok: true, order: { id: 'ord-5', status: 'completed', cards: [' '] } },
    });
    expect(
      await adapter().placeOrder(
        order({ offerId: 'gift:acash_my:10_myr', quantity: 1, fields: {} }),
      ),
    ).toMatchObject({ status: 'unknown', reason: 'FazerCards delivered an unreadable code' });
  });

  it('reads failed and refunded orders as definitive, with the supplier reason', async () => {
    server.reply({ body: fixture('order-refunded') });
    expect(await adapter().placeOrder(order())).toEqual({
      status: 'failed_definitive',
      supplierOrderId: 'ord-103',
      supplierCode: 'REFUND',
      reason: 'Player ID not found',
    });
    server.reply({ body: { ok: true, order: { id: 'ord-6', status: 'failed' } } });
    expect(await adapter().placeOrder(order())).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'FAILED',
      reason: 'Failed by FazerCards',
    });
  });

  it('refuses before sending what FazerCards cannot take', async () => {
    const before = server.requests.length;
    expect(await adapter().placeOrder(order({ offerId: '235203' }))).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'PRODUCT_NOT_FOUND',
    });
    expect(await adapter().placeOrder(order({ quantity: 2 }))).toMatchObject({
      supplierCode: 'QUANTITY_UNSUPPORTED',
    });
    expect(
      await adapter().placeOrder(order({ offerId: 'gift:a:b', quantity: 101, fields: {} })),
    ).toMatchObject({ supplierCode: 'QUANTITY_UNSUPPORTED' });
    expect(await adapter().placeOrder(order({ idempotencyKey: 'k'.repeat(256) }))).toMatchObject({
      supplierCode: 'IDEMPOTENCY_KEY_TOO_LONG',
    });
    expect(sentSince(before)).toHaveLength(0);
  });

  it('reads an inactive plan as refused before charging (FC9)', async () => {
    server.reply({ status: 403, body: fixture('error-subscription-inactive') });
    expect(await adapter().placeOrder(order())).toEqual({
      status: 'failed_definitive',
      supplierCode: 'subscription_inactive',
      reason: 'FazerCards plan inactive: refused before charging',
    });
  });

  it('keeps every other refusal, a 429, a 5xx, a timeout or a bad body unknown (ADR 0004)', async () => {
    for (const reply of [
      { status: 400, body: { ok: false, error: 'Validation failed' } },
      { status: 401, body: { ok: false, error: 'Invalid API key' } },
      { status: 409, body: { ok: false, error: 'Idempotency key reused' } },
      { status: 429, headers: { 'retry-after': '5' }, body: { ok: false } },
      { status: 502, body: 'bad gateway' },
      { body: { ok: true, order: { id: 'not-an-order' } } },
      { body: { ok: true, order: { id: 'ord-7', status: 'on_hold' } } },
    ]) {
      server.reply(reply);
      expect((await adapter().placeOrder(order())).status).toBe('unknown');
    }
    server.reply({ delayMs: 300, body: fixture('order-processing') });
    expect(await adapter({ timeoutMs: 50 }).placeOrder(order())).toMatchObject({
      status: 'unknown',
      failure: 'timeout',
    });
  });

  it("reads a completed gift card's codes when the poll's reply names no kind (A05-21)", async () => {
    server.reply({
      body: { ok: true, order: { id: 'ord-104', status: 'completed', cards: ['TEST-CODE-0003'] } },
    });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-104', quantity: 1 }),
    ).toMatchObject({ status: 'delivered', codes: ['TEST-CODE-0003'] });
  });

  it('polls by ord-N: processing, completed with codes, refunded, not found', async () => {
    const before = server.requests.length;
    server.reply({ body: fixture('order-processing') });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-101', quantity: 1 }),
    ).toMatchObject({ status: 'pending', supplierOrderId: 'ord-101' });
    expect(sentSince(before)[0]?.path).toBe('/api/v2/orders/ord-101');
    server.reply({ body: fixture('order-completed-gift') });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-102', quantity: 2 }),
    ).toMatchObject({
      status: 'delivered',
      codes: ['TEST-CODE-0001 · PIN: 1111', 'TEST-CODE-0002'],
    });
    server.reply({ body: fixture('order-refunded') });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-103', quantity: 1 }),
    ).toMatchObject({ status: 'failed_definitive', supplierCode: 'REFUND' });
    server.reply({ status: 404, body: { ok: false, error: 'Order not found' } });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-104', quantity: 1 }),
    ).toMatchObject({ status: 'unknown', supplierOrderId: 'ord-104', answered: true });
    server.reply({ status: 500, body: {} });
    const down = await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-104', quantity: 1 });
    expect(down).toMatchObject({ status: 'unknown', supplierOrderId: 'ord-104' });
    expect(down).not.toHaveProperty('answered');
  });

  it('cannot poll without an ord-N (the poll re-sends with the key)', async () => {
    expect(await adapter().getOrder(ATTEMPT_ID)).toMatchObject({ status: 'unknown' });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: '../me', quantity: 1 }),
    ).toMatchObject({ status: 'unknown' });
  });

  it('keeps a refused poll unknown, an inactive plan included', async () => {
    server.reply({ status: 403, body: fixture('error-subscription-inactive') });
    expect(
      await adapter().getOrder(ATTEMPT_ID, { supplierOrderId: 'ord-1', quantity: 1 }),
    ).toMatchObject({
      status: 'unknown',
      supplierOrderId: 'ord-1',
      supplierCode: 'subscription_inactive',
    });
  });
});

describe('FazercardsAdapter webhooks (FC7)', () => {
  const raw = (name: string) => JSON.stringify(fixture(name));
  const signed = (rawBody: string, prefix = 'sha256=') => ({
    headers: { [FZR_SIGNATURE_HEADER]: `${prefix}${hmacSha256(SECRET, rawBody)}` },
    rawBody,
  });

  it('accepts its own signature, with or without the prefix, within a day', () => {
    const body = raw('webhook-status-changed');
    const fazercards = adapter();
    expect(fazercards.verifyWebhook(signed(body))).toBe(true);
    expect(fazercards.verifyWebhook(signed(body, ''))).toBe(true);
    expect(fazercards.verifyWebhook(signed(body), new Date('2026-10-21T09:00:00Z'))).toBe(true);
  });

  it('refuses a wrong secret, a changed body, a stale event or no signature', () => {
    const body = raw('webhook-status-changed');
    const fazercards = adapter();
    expect(
      fazercards.verifyWebhook({
        headers: { [FZR_SIGNATURE_HEADER]: `sha256=${hmacSha256('other', body)}` },
        rawBody: body,
      }),
    ).toBe(false);
    expect(
      fazercards.verifyWebhook({ ...signed(body), rawBody: body.replace('completed', 'failed') }),
    ).toBe(false);
    expect(fazercards.verifyWebhook(signed(body), new Date('2026-10-21T10:00:00Z'))).toBe(false);
    expect(fazercards.verifyWebhook({ headers: {}, rawBody: body })).toBe(false);
    expect(fazercards.verifyWebhook(signed('not json'))).toBe(false);
    expect(
      fazercards.verifyWebhook(
        signed(JSON.stringify({ event: 'x', event_id: 'y', timestamp: 'not a time' })),
      ),
    ).toBe(false);
  });

  it('reads Unix seconds and milliseconds as the timestamp', () => {
    const seconds = JSON.stringify({
      event: 'webhook.test',
      event_id: 'e',
      timestamp: NOW.getTime() / 1000,
    });
    const millis = JSON.stringify({
      event: 'webhook.test',
      event_id: 'e',
      timestamp: String(NOW.getTime()),
    });
    const fazercards = adapter();
    expect(fazercards.verifyWebhook(signed(seconds))).toBe(true);
    expect(fazercards.verifyWebhook(signed(millis))).toBe(true);
    expect(
      fazercards.verifyWebhook(
        signed(JSON.stringify({ event: 'x', event_id: 'e', timestamp: 1.5e20 })),
      ),
    ).toBe(false);
  });

  it('maps a status change by ord-N; a completed gift card waits for the poll', () => {
    const fazercards = adapter();
    expect(
      fazercards.parseWebhook({ headers: {}, rawBody: raw('webhook-status-changed') }),
    ).toEqual({
      eventId: '00000000-0000-4000-8000-0000000000aa',
      supplierOrderId: 'ord-101',
      outcome: { status: 'delivered', supplierOrderId: 'ord-101', quantity: 1 },
    });
    const event = (data: Record<string, unknown>) =>
      fazercards.parseWebhook({
        headers: {},
        rawBody: JSON.stringify({
          event: 'order.status_changed',
          event_id: 'e1',
          timestamp: NOW.toISOString(),
          data: { order_id: 'ord-5', ...data },
        }),
      });
    expect(event({ type: 'gift_card', status: 'completed' }).outcome).toEqual({
      status: 'pending',
      supplierOrderId: 'ord-5',
    });
    expect(event({ status: 'processing' }).outcome.status).toBe('pending');
    expect(event({ status: 'refund', fail_reason: 'Wrong region' }).outcome).toEqual({
      status: 'failed_definitive',
      supplierOrderId: 'ord-5',
      supplierCode: 'REFUND',
      reason: 'Wrong region',
    });
    expect(event({ status: 'failed' }).outcome).toMatchObject({ reason: 'Failed by FazerCards' });
    expect(event({ status: 'on_hold' }).ignored).toBe(true);
    expect(event({ order_id: 'x', status: 'completed' }).ignored).toBe(true);
  });

  it('ignores tests, creations and chat events; refuses a malformed body', () => {
    const fazercards = adapter();
    expect(fazercards.parseWebhook({ headers: {}, rawBody: raw('webhook-test') })).toMatchObject({
      eventId: '00000000-0000-4000-8000-0000000000bb',
      ignored: true,
    });
    expect(() => fazercards.parseWebhook({ headers: {}, rawBody: '{"event":1}' })).toThrow(
      SupplierError,
    );
  });
});
