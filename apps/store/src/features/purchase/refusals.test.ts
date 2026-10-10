import { describe, expect, it } from 'vitest';
import ar from '../../messages/ar.json';
import { purchaseRefusalText } from './refusals';

describe('purchaseRefusalText (S12 LM4)', () => {
  it('says what remains of the daily cap', () => {
    const text = purchaseRefusalText('PURCHASE_LIMIT_EXCEEDED', {
      limitUnits: 20_000_000,
      remainingUnits: 4_500_000,
    });
    expect(text).toContain('$4.50');
    expect(text.startsWith(ar.purchase.capExceeded.split('{')[0] ?? '')).toBe(true);
  });

  it('falls back to the code’s text without details', () => {
    expect(purchaseRefusalText('PURCHASE_LIMIT_EXCEEDED', undefined)).toBe(
      ar.errors.PURCHASE_LIMIT_EXCEEDED,
    );
    expect(purchaseRefusalText('ACCOUNT_FROZEN', undefined)).toBe(ar.errors.ACCOUNT_FROZEN);
  });
});
