import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { depositAmount } from './deposit-labels';

describe('depositAmount', () => {
  const t = i18n.t.bind(i18n);

  it('writes pounds with the SYP sign and dollars with the dollar sign', () => {
    expect(depositAmount(t, 'SYP', 200_000)).toBe('2,000 ل.س');
    expect(depositAmount(t, 'USD', 25_000_000)).toBe('\u2066$25.00\u2069');
  });
});
