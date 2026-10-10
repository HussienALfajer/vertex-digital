import { describe, expect, it, vi } from 'vitest';
import type { CartLine } from './cart';
import { checkoutLine, lineRefusals, payCart } from './requests';

const line: CartLine = {
  id: 'local',
  productId: '0199e000-0000-7000-8000-0000000000a1',
  gameSlug: 'pubg-mobile',
  quantity: 2,
  maxQuantity: 10,
  fields: { player_id: '51234567' },
  expectedUnitPriceUsdUnits: 990_000,
  confirmPlayer: true,
  playerCheck: { result: 'invalid', playerName: null },
  display: { gameNameAr: 'ببجي', productNameAr: '60 UC', cover: null, fields: [] },
};

describe('the checkout request (rule CT5)', () => {
  it('sends the lines with the attempt key', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'c' }, { status: 201 }));
    const body = { lines: [checkoutLine(line)] };
    expect(await payCart(body, 'key-1', fetcher)).toEqual({ ok: true, data: { id: 'c' } });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/checkouts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'idempotency-key': 'key-1' }),
        body: JSON.stringify(body),
      }),
    );
  });

  it('sends only what a purchase reads, with the save and the gift when chosen', () => {
    expect(checkoutLine(line)).toEqual({
      productId: line.productId,
      quantity: 2,
      fields: { player_id: '51234567' },
      expectedUnitPriceUsdUnits: 990_000,
      confirmPlayer: true,
    });
    expect(
      checkoutLine({ ...line, savePlayer: { label: 'أخي' }, gift: { senderName: 'أحمد' } }),
    ).toMatchObject({ savePlayer: { label: 'أخي' }, gift: { senderName: 'أحمد' } });
  });
});

describe('the refusal of each line (rule CT6)', () => {
  it('reads the reasons by line index and skips anything malformed', () => {
    const refusals = lineRefusals({
      lines: [
        { index: 0, code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: 1_000_000 } },
        { index: 2, code: 'PLAYER_NOT_CONFIRMED' },
        { index: 3, code: 'SOMETHING_ELSE', details: {} },
        { code: 'PRODUCT_UNAVAILABLE' },
        null,
      ],
    });
    expect([...refusals.keys()]).toEqual([0, 2]);
    expect(refusals.get(0)).toEqual({
      index: 0,
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: 1_000_000 },
    });
    expect(refusals.get(2)?.details).toEqual({});
    expect(lineRefusals(undefined).size).toBe(0);
    expect(lineRefusals({ lines: 'x' }).size).toBe(0);
  });
});
