import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import { fieldValue } from './audit-labels';

const t = i18n.t.bind(i18n);

describe('fieldValue', () => {
  it('shows USD amounts as dollars', () => {
    expect(fieldValue(t, 'amountUnits', 25_000_000)).toBe('$25.00');
    expect(fieldValue(t, 'balanceAfterUnits', 0)).toBe('$0.00');
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
