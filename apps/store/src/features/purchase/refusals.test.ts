import { describe, expect, it } from 'vitest';
import ar from '../../messages/ar.json';
import credit from '../credit/messages.ar.json';
import { purchaseRefusalText } from './refusals';

const lead = (text: string) => text.split('{')[0] ?? '';

describe('purchaseRefusalText (S12 LM4)', () => {
  it('says what remains of the daily cap', () => {
    const text = purchaseRefusalText('PURCHASE_LIMIT_EXCEEDED', {
      limitUnits: 20_000_000,
      remainingUnits: 4_500_000,
    });
    expect(text).toContain('$4.50');
    expect(text.startsWith(lead(ar.purchase.capExceeded))).toBe(true);
  });

  it('falls back to the code’s text without details', () => {
    expect(purchaseRefusalText('PURCHASE_LIMIT_EXCEEDED', undefined)).toBe(
      ar.errors.PURCHASE_LIMIT_EXCEEDED,
    );
    expect(purchaseRefusalText('ACCOUNT_FROZEN', undefined)).toBe(ar.errors.ACCOUNT_FROZEN);
    for (const code of [
      'CREDIT_DAILY_LIMIT',
      'CASH_DAILY_LIMIT',
      'RECIPIENT_DAILY_LIMIT',
      'CASH_BALANCE_TOO_RECENT',
    ] as const)
      expect(purchaseRefusalText(code, {})).toBe(ar.errors[code]);
  });
});

describe('purchaseRefusalText (S25 CL2, CL3, CS1, CS2)', () => {
  it('says what remains of the section and cash caps', () => {
    const section = purchaseRefusalText('CREDIT_DAILY_LIMIT', { remainingUsdUnits: 12_340_000 });
    expect(section).toContain('$12.34');
    expect(section.startsWith(lead(credit.limits.credit))).toBe(true);
    const cash = purchaseRefusalText('CASH_DAILY_LIMIT', { remainingUsdUnits: 0 });
    expect(cash).toContain('$0.00');
    expect(cash.startsWith(lead(credit.limits.cash))).toBe(true);
  });

  it('names the number’s daily count', () => {
    expect(purchaseRefusalText('RECIPIENT_DAILY_LIMIT', { recipient: 'x', limit: 5 })).toContain(
      '5',
    );
  });

  it('says what a cash order may use now, and when more', () => {
    expect(purchaseRefusalText('CASH_BALANCE_TOO_RECENT', { eligibleUsdUnits: 3_000_000 })).toBe(
      credit.limits.recent.replace('{eligible}', '⁦$3.00⁩'),
    );
    const later = purchaseRefusalText('CASH_BALANCE_TOO_RECENT', {
      eligibleUsdUnits: 3_000_000,
      eligibleMoreAt: '2026-11-06T10:00:00.000Z',
    });
    expect(later.startsWith(lead(credit.limits.recentMore))).toBe(true);
  });
});
