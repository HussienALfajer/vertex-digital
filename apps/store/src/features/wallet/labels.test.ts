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

  it('names other journals by their kind', () => {
    expect(entryLabel(entry({ kind: 'deposit' }))).toBe(ar.wallet.kinds.deposit);
  });
});
