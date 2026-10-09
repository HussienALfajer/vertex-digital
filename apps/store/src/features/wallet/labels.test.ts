import type { WalletEntry } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import ar from '../../messages/ar.json';
import { entryLabel } from './labels';

const entry = (changes: Partial<WalletEntry>): WalletEntry => ({
  occurredAt: '2026-10-08T09:00:00.000Z',
  kind: 'adjustment',
  amountUnits: 25_000_000,
  balanceAfterUnits: 25_000_000,
  adjustment: null,
  deposit: null,
  order: null,
  ...changes,
});

describe('entryLabel', () => {
  it('names an adjustment by its category', () => {
    const adjustment = { category: 'test_funds', customerNote: null, reversal: false } as const;
    expect(entryLabel(entry({ adjustment }))).toBe(ar.wallet.categories.test_funds);
  });

  it('names a reversal after the category it reverses', () => {
    const adjustment = { category: 'compensation', customerNote: null, reversal: true } as const;
    expect(entryLabel(entry({ adjustment }))).toBe(
      ar.wallet.reversal.replace('{category}', ar.wallet.categories.compensation),
    );
  });

  it('names a purchase and its refund by the product (S08)', () => {
    const order = {
      id: '0199a000-0000-7000-8000-000000000001',
      number: 'VO-7KQ2MX',
      productNameAr: '60 UC',
    };
    expect(entryLabel(entry({ kind: 'purchase', order }))).toBe(
      ar.wallet.orderKinds.purchase.replace('{product}', '60 UC'),
    );
    expect(entryLabel(entry({ kind: 'refund', order }))).toBe(
      ar.wallet.orderKinds.refund.replace('{product}', '60 UC'),
    );
  });

  it('names other journals by their kind', () => {
    expect(entryLabel(entry({ kind: 'deposit' }))).toBe(ar.wallet.kinds.deposit);
  });

  it('names a deposit by its method (S03)', () => {
    const deposit = { method: 'sham_cash', referenceCode: 'VD-7KQ2M', syp: null } as const;
    expect(entryLabel(entry({ kind: 'deposit', deposit }))).toBe(
      ar.wallet.depositMethods.sham_cash,
    );
  });
});
