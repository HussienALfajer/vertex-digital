import type { StatementEntry } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import {
  matchesMovement,
  movementChips,
  movementDays,
  movementTitle,
  statementFlow,
} from './statement-view';

const order = (number: string, playerId: string) => ({
  id: '0199e200-0000-7000-8000-0000000000a1',
  number,
  gameNameAr: 'ببجي',
  productNameAr: '60 UC',
  quantity: 1,
  fields: [{ labelAr: 'المعرّف', value: playerId }],
});

const entry = (changes: Partial<StatementEntry>): StatementEntry => ({
  occurredAt: '2026-10-30T10:00:00.000Z',
  kind: 'purchase',
  amountUnits: -4_800_000,
  balanceAfterUnits: 0,
  deposit: null,
  adjustment: null,
  order: null,
  checkout: null,
  ...changes,
});

const deposit = entry({
  occurredAt: '2026-10-29T21:30:00.000Z',
  kind: 'deposit',
  amountUnits: 4_800_000,
  balanceAfterUnits: 4_800_000,
  deposit: { method: 'sham_cash', referenceCode: 'VD-1', syp: null },
});
const purchase = entry({ order: order('VO-ABC123', '5123456789') });

describe('the statement screen (owner, 2026-10-30)', () => {
  it('sums what came in and went out, opening + in − out = closing', () => {
    expect(
      statementFlow({ openingUsdUnits: 0, closingUsdUnits: 0, entries: [deposit, purchase] }),
    ).toEqual({ openingUnits: 0, inUnits: 4_800_000, outUnits: 4_800_000, closingUnits: 0 });
  });

  it('offers a chip per kind the month holds, with its count', () => {
    expect(movementChips([deposit, purchase, purchase])).toEqual([
      { filter: 'all', count: 3 },
      { filter: 'deposit', count: 1 },
      { filter: 'purchase', count: 2 },
    ]);
    expect(movementChips([entry({ kind: 'treasury' })])).toEqual([
      { filter: 'all', count: 1 },
      { filter: 'other', count: 1 },
    ]);
  });

  it('finds an order by its number or its player id, a checkout by its orders', () => {
    const checkout = entry({
      checkout: { id: '0199e200-0000-7000-8000-0000000000c1', orders: [order('VO-XYZ', '777')] },
    });
    expect(matchesMovement(purchase, 'vo-abc')).toBe(true);
    expect(matchesMovement(purchase, '456789')).toBe(true);
    expect(matchesMovement(checkout, '777')).toBe(true);
    expect(matchesMovement(deposit, '777')).toBe(false);
    expect(matchesMovement(deposit, '  ')).toBe(true);
  });

  it('groups by the Damascus day, newest first', () => {
    // 21:30 UTC on the 29th is 00:30 on the 30th in Damascus.
    const late = entry({ occurredAt: '2026-10-28T10:00:00.000Z' });
    expect(
      movementDays([late, deposit, purchase]).map((day) => [day.day, day.entries.length]),
    ).toEqual([
      ['2026-10-30', 2],
      ['2026-10-28', 1],
    ]);
    expect(movementDays([late, deposit, purchase])[0]?.entries[0]).toBe(purchase);
  });

  it('names each movement clearly', () => {
    expect(movementTitle(deposit)).toEqual({ key: 'deposit', method: 'sham_cash' });
    expect(movementTitle(purchase)).toEqual({ key: 'purchase', productNameAr: '60 UC' });
    expect(
      movementTitle(
        entry({
          checkout: {
            id: '0199e200-0000-7000-8000-0000000000c1',
            orders: [order('a', '1'), order('b', '2')],
          },
        }),
      ),
    ).toEqual({ key: 'checkout', count: 2 });
    expect(movementTitle(entry({ kind: 'refund', amountUnits: 1 }))).toEqual({ key: 'refund' });
    expect(
      movementTitle(
        entry({
          kind: 'adjustment',
          amountUnits: 1_000_000,
          adjustment: { category: 'compensation', customerNote: null, reversal: false },
        }),
      ),
    ).toEqual({ key: 'adjustment', category: 'compensation', credit: true, reversal: false });
    expect(movementTitle(entry({ kind: 'treasury' }))).toEqual({ key: 'other' });
  });
});
