import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import {
  addressGroups,
  amountFromCentsParam,
  amountText,
  centsParam,
  limitText,
  parseDepositAmount,
  prefillText,
  presetUnits,
  previewUsd,
  splitPayAmount,
} from './amounts';

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

  it('splits the exact USDT amount and the address for the eye', () => {
    expect(splitPayAmount('25.0037')).toEqual({ head: '25.00', tail: '37' });
    expect(addressGroups('TXYZabcd1234ef')).toEqual(['TXYZ', 'abcd', '1234', 'ef']);
    expect(addressGroups('')).toEqual([]);
  });
});

describe('the ?amount= of the wizard (S09 rule BB8)', () => {
  it('writes whole cents as digits and reads them back', () => {
    expect(centsParam(12_050_000)).toBe('1205');
    expect(centsParam(5_000_000)).toBe('500');
    expect(centsParam(10_000)).toBe('1');
    expect(amountFromCentsParam('1205')).toBe(12_050_000);
    expect(amountFromCentsParam('1')).toBe(10_000);
    expect(amountFromCentsParam('007')).toBe(70_000);
  });

  it('ignores anything else', () => {
    for (const param of [null, '', '0', '12.5', '-3', 'abc', '123456789012'])
      expect(amountFromCentsParam(param)).toBeNull();
  });
});

describe('prefillText (S09 rule BB8)', () => {
  it('takes the larger of the shortfall and the minimum', () => {
    expect(prefillText(null, 5_000_000)).toBe('');
    expect(prefillText(3_500_000, 5_000_000)).toBe('5');
    expect(prefillText(12_050_000, 5_000_000)).toBe('12.05');
    expect(prefillText(12_050_000, undefined)).toBe('12.05');
  });
});
