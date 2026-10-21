import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import {
  addressGroups,
  amountFromCentsParam,
  amountText,
  centsParam,
  gapFill,
  limitText,
  parseDepositAmount,
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
    // Twelve digits of pounds at 100 are past the safe integers: no preview, the limit refuses.
    expect(previewUsd(99_999_999_999_900, '100')).toBeNull();
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

describe('the ?gap= of the wizard (S22 BG2)', () => {
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

describe('gapFill (S22 BG3)', () => {
  const limits = {
    established: true,
    minUnits: 5_000_000,
    perDepositUnits: 500_000_000,
    dailyUnits: 1_000_000_000,
    remainingTodayUnits: 1_000_000_000,
  };
  const rate = { sypPerUsd: '14650', displayStepSypUnits: 500 };

  it('raises a gap to the minimum, in dollars or in pounds on the step', () => {
    expect(gapFill(400_000, 'USD', limits, rate)).toEqual({
      text: '5',
      raisedToMinimum: true,
      short: false,
    });
    expect(gapFill(13_700_000, 'USD', limits, rate)).toEqual({
      text: '13.70',
      raisedToMinimum: false,
      short: false,
    });
    // $13.71 × 14,650 = 200,851.5 SYP, up to the 5-pound step.
    expect(gapFill(13_710_000, 'SYP', limits, rate).text).toBe('200855');
  });

  it('holds the cap and says the rest needs another deposit', () => {
    expect(gapFill(800_000_000, 'USD', limits, rate)).toEqual({
      text: '500',
      raisedToMinimum: false,
      short: true,
    });
  });

  it('works without limits, and leaves pounds empty without a rate', () => {
    expect(gapFill(1_370_000, 'USD', null, null).text).toBe('1.37');
    expect(gapFill(1_370_000, 'SYP', null, null).text).toBe('');
  });
});
