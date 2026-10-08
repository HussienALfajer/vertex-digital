import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import { amountText, limitText, parseDepositAmount, presetUnits, previewUsd } from './amounts';

const USD = 1_000_000;
const rate = { sypPerUsd: '118', displayStepSypUnits: 500 };

describe('the deposit amounts', () => {
  it('reads whole pounds and dollars with cents, never zero', () => {
    expect(parseDepositAmount('SYP', '2000')).toBe(200_000);
    expect(parseDepositAmount('SYP', '2000.5')).toBeNull();
    expect(parseDepositAmount('USD', '25.5')).toBe(25_500_000);
    expect(parseDepositAmount('USD', '0')).toBeNull();
    expect(parseDepositAmount('USD', 'abc')).toBeNull();
  });

  it('turns a USD preset into pounds rounded up to the step', () => {
    expect(presetUnits('USD', 10 * USD, null)).toBe(10 * USD);
    // $10 × 118 = 1,180 pounds, up to the next 5: 1,180.
    expect(presetUnits('SYP', 10 * USD, rate)).toBe(118_000);
    expect(presetUnits('SYP', 5 * USD, { ...rate, sypPerUsd: '118.3' })).toBe(59_500);
    expect(presetUnits('SYP', 5 * USD, null)).toBeNull();
  });

  it('previews the USD of pounds, floored to cents (rule FX6)', () => {
    expect(previewUsd(200_000, '118')).toBe(16_940_000);
  });

  it('writes amounts with their currency', () => {
    expect(amountText('SYP', 200_000)).toBe('2,000 ل.س');
    expect(amountText('USD', 50 * USD)).toBe('\u2066$50.00\u2069');
  });

  it('explains each limit from the refusal’s details', () => {
    const details = { limitUnits: 50 * USD, remainingUnits: 40 * USD };
    expect(limitText({ ...details, limit: 'minimum' })).toBe(
      ar.deposits.limits.minimum.replace('{limit}', '\u2066$50.00\u2069'),
    );
    expect(limitText({ ...details, limit: 'per_deposit' })).toBe(
      ar.deposits.limits.perDeposit.replace('{limit}', '\u2066$50.00\u2069'),
    );
    expect(limitText({ ...details, limit: 'daily' })).toBe(
      ar.deposits.limits.daily
        .replace('{limit}', '\u2066$50.00\u2069')
        .replace('{remaining}', '\u2066$40.00\u2069'),
    );
    expect(limitText({ ...details, limit: 'other' })).toBeNull();
    expect(limitText(undefined)).toBeNull();
  });
});
