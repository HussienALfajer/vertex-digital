import type { AdminWalletEntry } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import { entryLabel } from './wallet-labels';

const t = i18n.t.bind(i18n);

const adjustment: NonNullable<AdminWalletEntry['adjustment']> = {
  id: '0199a000-0000-7000-8000-0000000000b1',
  direction: 'credit',
  category: 'compensation',
  customerNote: null,
  reversal: false,
  reason: 'تأخر الطلب',
  adminName: 'ريم الخطيب',
  depositMethod: null,
  externalReference: null,
  reversesAdjustmentId: null,
  reversedByAdjustmentId: null,
};

const entry = (changes: Partial<AdminWalletEntry>): AdminWalletEntry => ({
  occurredAt: '2026-10-08T09:00:00.000Z',
  kind: 'adjustment',
  amountUnits: 25_000_000,
  balanceAfterUnits: 25_000_000,
  journalId: '0199a000-0000-7000-8000-0000000000c1',
  adjustment,
  ...changes,
});

describe('entryLabel', () => {
  it('names an adjustment by its category, and a reversal after it', () => {
    expect(entryLabel(t, entry({}))).toBe(ar.wallets.categories.compensation);
    expect(entryLabel(t, entry({ adjustment: { ...adjustment, reversal: true } }))).toBe(
      `عكس: ${ar.wallets.categories.compensation}`,
    );
  });

  it('names other journals by their kind', () => {
    expect(entryLabel(t, entry({ kind: 'deposit', adjustment: null }))).toBe(
      ar.wallets.kinds.deposit,
    );
  });
});
