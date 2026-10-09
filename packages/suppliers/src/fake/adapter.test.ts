import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PlaceOrderRequest } from '../core/adapter.js';
import { SupplierError } from '../core/errors.js';
import {
  FAKE_SIGNATURE_HEADER,
  FAKE_TIMESTAMP_HEADER,
  FakeSupplierAdapter,
  type FakeSupplierState,
  fakeSupplierStateSchema,
} from './adapter.js';

const webhookSecret = 'fake-webhook-secret';
const adapter = (options: { balanceUsdUnits?: number; state?: Partial<FakeSupplierState> } = {}) =>
  new FakeSupplierAdapter({
    webhookSecret,
    slowMs: 20,
    ...options,
    state: fakeSupplierStateSchema.parse(options.state ?? {}),
  });

const order = (
  playerId: string,
  overrides: Partial<PlaceOrderRequest> = {},
): PlaceOrderRequest => ({
  idempotencyKey: randomUUID(),
  offerId: 'fake-uc-60',
  quantity: 1,
  fields: { playerId },
  ...overrides,
});

describe('fake supplier', () => {
  it('lists offers in USD units and reports its balance', async () => {
    const fake = adapter();
    const offers = await fake.listOffers();
    expect(offers).toContainEqual({
      offerId: 'fake-uc-60',
      name: 'Fake UC 60',
      cost: { currency: 'USD', amountUnits: 880_000 },
      inStock: true,
      group: 'PUBG Mobile',
      kind: 'direct',
      requiredFields: ['playerId'],
    });
    expect(offers).toHaveLength(10);
    expect(new Set(offers.map((offer) => offer.group))).toEqual(
      new Set(['PUBG Mobile', 'Free Fire', 'iTunes']),
    );
    expect(offers.find((offer) => offer.offerId === 'fake-gift-10')).toMatchObject({
      kind: 'code',
      requiredFields: [],
    });
    expect(await fake.getBalance()).toEqual({ currency: 'USD', amountUnits: 1_000_000_000 });
  });

  it('follows its scripted state: costs, stock, removals, failures, balance', async () => {
    const scripted = adapter({
      state: {
        costs: { 'fake-uc-60': 920_000 },
        outOfStock: ['fake-uc-325'],
        removed: ['fake-ff-100'],
        balanceUsdUnits: 20_000_000,
      },
    });
    const offers = await scripted.listOffers();
    expect(offers.find((offer) => offer.offerId === 'fake-uc-60')?.cost.amountUnits).toBe(920_000);
    expect(offers.find((offer) => offer.offerId === 'fake-uc-325')?.inStock).toBe(false);
    expect(offers.some((offer) => offer.offerId === 'fake-ff-100')).toBe(false);
    expect(await scripted.getBalance()).toEqual({ currency: 'USD', amountUnits: 20_000_000 });
    expect(await scripted.placeOrder(order('51234567', { offerId: 'fake-ff-100' }))).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'FAKE_REFUSED',
    });
    expect(await scripted.placeOrder(order('51234567', { offerId: 'fake-uc-325' }))).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'OUT_OF_STOCK',
    });

    const failingSync = adapter({ state: { failSync: true } });
    await expect(failingSync.listOffers()).rejects.toMatchObject({ kind: 'retryable' });
    expect((await failingSync.getBalance()).currency).toBe('USD');

    const down = adapter({ state: { errors: true } });
    await expect(down.listOffers()).rejects.toThrow(SupplierError);
    await expect(down.getBalance()).rejects.toMatchObject({ kind: 'retryable' });
    await expect(
      down.validatePlayer({ offerId: 'fake-uc-60', fields: { playerId: '51234567' } }),
    ).rejects.toThrow(SupplierError);
  });

  it('validates players', async () => {
    const fake = adapter();
    expect(
      await fake.validatePlayer({ offerId: 'fake-uc-60', fields: { playerId: '51234567' } }),
    ).toEqual({
      valid: true,
      playerName: 'Player 4567',
    });
    expect(
      await fake.validatePlayer({ offerId: 'fake-uc-60', fields: { playerId: 'invalid-1' } }),
    ).toEqual({
      valid: false,
    });
    await expect(fake.validatePlayer({ offerId: 'fake-uc-60', fields: {} })).rejects.toThrow(
      SupplierError,
    );
  });

  it('delivers at once, with codes for code products, and charges its balance', async () => {
    const fake = adapter();
    expect(await fake.placeOrder(order('51234567'))).toMatchObject({ status: 'delivered' });
    const gift = await fake.placeOrder(order('51234567', { offerId: 'fake-gift-10', quantity: 2 }));
    expect(gift).toMatchObject({
      status: 'delivered',
      codes: [expect.stringMatching(/^FAKE-/), expect.any(String)],
    });
    expect((await fake.getBalance()).amountUnits).toBe(1_000_000_000 - 880_000 - 2 * 9_600_000);
  });

  it('answers a repeated key with the first order, never a second purchase', async () => {
    const fake = adapter();
    const request = order('51234567');
    const first = await fake.placeOrder(request);
    expect(await fake.placeOrder(request)).toEqual(first);
    expect((await fake.getBalance()).amountUnits).toBe(1_000_000_000 - 880_000);
    expect(await fake.placeOrder({ ...request, offerId: 'fake-uc-325' })).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('refuses definitively: scripted failure, unknown offer, low balance', async () => {
    const fake = adapter({ balanceUsdUnits: 1_000_000 });
    expect(await fake.placeOrder(order('fail-1'))).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'FAKE_REFUSED',
    });
    expect(await fake.placeOrder(order('5123', { offerId: 'nope' }))).toMatchObject({
      status: 'failed_definitive',
    });
    expect(await fake.placeOrder(order('5123', { offerId: 'fake-uc-325' }))).toMatchObject({
      status: 'failed_definitive',
      supplierCode: 'INSUFFICIENT_BALANCE',
    });
  });

  it('delivers slow orders late', async () => {
    const started = Date.now();
    expect(await adapter().placeOrder(order('slow-1'))).toMatchObject({ status: 'delivered' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('refuses an order whose account fields the supplier rejects (S08 rule F1)', async () => {
    expect(await adapter().placeOrder(order('invalid-1'))).toEqual({
      status: 'failed_definitive',
      supplierCode: 'PLAYER_NOT_FOUND',
      inputRejected: true,
      reason: 'Player not found at the fake supplier',
    });
  });

  it('settles a pending order by a signed webhook', async () => {
    const fake = adapter();
    const request = order('pending-1');
    const placed = await fake.placeOrder(request);
    expect(placed).toMatchObject({ status: 'pending' });
    expect(await fake.getOrder(request.idempotencyKey)).toEqual(placed);

    const webhook = fake.completePending(request.idempotencyKey);
    expect(fake.verifyWebhook(webhook)).toBe(true);
    expect(fake.parseWebhook(webhook)).toEqual({
      eventId: expect.stringMatching(/^evt-/),
      idempotencyKey: request.idempotencyKey,
      outcome: {
        status: 'delivered',
        supplierOrderId: (placed as { supplierOrderId: string }).supplierOrderId,
        quantity: 1,
      },
    });
    expect(await fake.getOrder(request.idempotencyKey)).toMatchObject({ status: 'delivered' });
    expect(() => fake.completePending(request.idempotencyKey)).toThrow();
  });

  it('resolves an unknown outcome by polling, or by sending again with the same key', async () => {
    const fake = adapter();
    const request = order('unknown-1');
    expect(await fake.placeOrder(request)).toMatchObject({ status: 'unknown' });
    expect(await fake.getOrder(request.idempotencyKey)).toMatchObject({ status: 'delivered' });
    expect(await fake.placeOrder(request)).toMatchObject({ status: 'delivered', quantity: 1 });
    expect(await fake.getOrder('never-placed')).toMatchObject({ status: 'unknown' });
  });

  it('refuses a wrongly signed, tampered, stale or malformed webhook', async () => {
    const fake = adapter();
    const bad = order('badsig-1');
    await fake.placeOrder(bad);
    expect(fake.verifyWebhook(fake.completePending(bad.idempotencyKey))).toBe(false);

    const good = order('pending-2');
    await fake.placeOrder(good);
    const webhook = fake.completePending(good.idempotencyKey);
    expect(
      fake.verifyWebhook({ ...webhook, rawBody: webhook.rawBody.replace('delivered', 'failed') }),
    ).toBe(false);
    expect(fake.verifyWebhook(webhook, new Date(Date.now() + 10 * 60_000))).toBe(false);
    expect(
      fake.verifyWebhook({
        ...webhook,
        headers: { ...webhook.headers, [FAKE_TIMESTAMP_HEADER]: 'x' },
      }),
    ).toBe(false);
    expect(
      fake.verifyWebhook({
        ...webhook,
        headers: { ...webhook.headers, [FAKE_SIGNATURE_HEADER]: undefined },
      }),
    ).toBe(false);
    expect(() => fake.parseWebhook({ headers: {}, rawBody: '{"eventId":1}' })).toThrow(
      SupplierError,
    );
  });

  it('parses a failed webhook as definitive', () => {
    const event = adapter().parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        eventId: 'e1',
        idempotencyKey: 'k1',
        supplierOrderId: 's1',
        status: 'failed',
      }),
    });
    expect(event.outcome).toMatchObject({ status: 'failed_definitive', supplierOrderId: 's1' });
  });
});
