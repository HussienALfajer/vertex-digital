import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import { fieldValue } from './audit-labels';

const t = i18n.t.bind(i18n);

describe('fieldValue', () => {
  it('shows USD amounts as dollars', () => {
    expect(fieldValue(t, 'amountUnits', 25_000_000)).toBe('$25.00');
    expect(fieldValue(t, 'balanceAfterUnits', 0)).toBe('$0.00');
    expect(fieldValue(t, 'creditedUsdUnits', 16_100_000)).toBe('$16.10');
    expect(fieldValue(t, 'declaredUsdUnits', 16_940_000)).toBe('$16.94');
    expect(fieldValue(t, 'officialPriceUsdUnits', 990_000)).toBe('$0.99');
    expect(fieldValue(t, 'minMarginUsdUnits', 100_000)).toBe('$0.10');
  });

  it('shows a margin rule percent with its sign (S06)', () => {
    expect(fieldValue(t, 'percentBp', 1000)).toBe('10%');
    expect(fieldValue(t, 'percentBp', 1250)).toBe('12.5%');
  });

  it('shows deposit codes by their labels', () => {
    expect(fieldValue(t, 'rejectReason', 'receipt_invalid')).toBe(
      ar.deposits.rejectReasons.receipt_invalid,
    );
    expect(fieldValue(t, 'referenceCheck', 'missing')).toBe(ar.deposits.referenceChecks.missing);
    expect(fieldValue(t, 'rejectReason', 'unknown')).toBe('unknown');
  });

  it('shows wallet adjustment codes by their labels', () => {
    expect(fieldValue(t, 'direction', 'debit')).toBe(ar.wallets.directions.debit);
    expect(fieldValue(t, 'category', 'test_funds')).toBe(ar.wallets.categories.test_funds);
    expect(fieldValue(t, 'depositMethod', 'sham_cash')).toBe(ar.wallets.methods.sham_cash);
  });

  it('shows anything else as written', () => {
    expect(fieldValue(t, 'name', 'سارة')).toBe('سارة');
    expect(fieldValue(t, 'category', 'unknown')).toBe('unknown');
    expect(fieldValue(t, 'amountUnits', '25')).toBe('25');
    expect(fieldValue(t, 'depositMethod', null)).toBe('—');
    expect(fieldValue(t, 'count', 3)).toBe('3');
  });
});
