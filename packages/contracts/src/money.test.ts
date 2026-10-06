import { describe, expect, it } from 'vitest';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  ceilToStep,
  currencySchema,
  exchangeRateSchema,
  isWholeCents,
  sypDisplayPrice,
  sypToUsd,
  USD_CENT,
  usdCentsSchema,
  usdToSyp,
} from './money.js';

describe('currencies and units', () => {
  it('stores USD in micro-dollars and SYP in hundredths', () => {
    expect(CURRENCY_SCALE).toEqual({ USD: 1_000_000, SYP: 100 });
    expect(USD_CENT).toBe(CURRENCY_SCALE.USD / 100);
  });

  it('knows only the ledger currencies', () => {
    expect(currencySchema.safeParse('USD').success).toBe(true);
    expect(currencySchema.safeParse('SYP').success).toBe(true);
    expect(currencySchema.safeParse('USDT').success).toBe(false);
  });

  it('accepts amounts that are non-negative safe integers only', () => {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(amountUnitsSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '100']) {
      expect(amountUnitsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts customer-facing USD amounts in whole cents only', () => {
    for (const value of [0, USD_CENT, 12_300_000]) {
      expect(usdCentsSchema.safeParse(value).success).toBe(true);
    }
    // $0.889 is a valid supplier cost but never a price or a credit.
    for (const value of [1, USD_CENT / 2, 889_000, -USD_CENT]) {
      expect(usdCentsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('tells whole cents apart in either sign', () => {
    expect(isWholeCents(5_000_000)).toBe(true);
    expect(isWholeCents(-5_000_000)).toBe(true);
    expect(isWholeCents(-5)).toBe(false);
    expect(isWholeCents(USD_CENT + 0.5)).toBe(false);
    expect(isWholeCents(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});

describe('exchange rate', () => {
  it('accepts SYP per USD above 0 with up to 4 decimals', () => {
    for (const rate of ['118', '118.5', '118.5000', '0.0001', '99999999.9999']) {
      expect(exchangeRateSchema.parse(rate)).toBe(rate);
    }
    expect(exchangeRateSchema.parse(' 118.25 ')).toBe('118.25');
  });

  it('refuses zero, negative, inexact or malformed rates', () => {
    for (const rate of [
      '0',
      '0.0000',
      '-1',
      '1e2',
      '118.12345',
      '118.',
      '.5',
      '1,5',
      '123456789',
      '',
      'abc',
    ]) {
      expect(exchangeRateSchema.safeParse(rate).success).toBe(false);
    }
  });
});

describe('USD and SYP conversion', () => {
  it('converts exactly when the result is whole', () => {
    expect(usdToSyp(1_000_000, '118.5', 'up')).toBe(11_850);
    expect(usdToSyp(1_000_000, '118.5', 'down')).toBe(11_850);
    expect(sypToUsd(11_850, '118.5', 'up')).toBe(1_000_000);
    expect(sypToUsd(11_850, '118.5', 'down')).toBe(1_000_000);
    expect(usdToSyp(0, '118.5', 'up')).toBe(0);
  });

  it('rounds a fraction of a unit in the direction asked, never through floats', () => {
    // $0.889 × 118.5 = 105.3465 SYP = 10,534.65 units.
    expect(usdToSyp(889_000, '118.5', 'up')).toBe(10_535);
    expect(usdToSyp(889_000, '118.5', 'down')).toBe(10_534);
    // 100 SYP ÷ 118.5 = $0.843881856… = 843,881.856… units.
    expect(sypToUsd(10_000, '118.5', 'up')).toBe(843_882);
    expect(sypToUsd(10_000, '118.5', 'down')).toBe(843_881);
    // 0.1 + 0.2 style float errors cannot appear: 3 units at a rate of 0.1 is exact.
    expect(usdToSyp(300_000, '0.1', 'up')).toBe(3);
  });

  it('never gives back more than it was given when rounding down both ways', () => {
    for (const amount of [1, 7, 889_000, 1_234_567, 25_000_000, 99_990_000]) {
      for (const rate of ['1', '118.5', '13250.75', '0.0001']) {
        const back = sypToUsd(usdToSyp(amount, rate, 'down'), rate, 'down');
        expect(back).toBeLessThanOrEqual(amount);
      }
    }
  });

  it('refuses negative, fractional or unsafe amounts and invalid rates', () => {
    expect(() => usdToSyp(-1, '118.5', 'up')).toThrow(RangeError);
    expect(() => usdToSyp(1.5, '118.5', 'up')).toThrow(RangeError);
    expect(() => sypToUsd(Number.MAX_SAFE_INTEGER + 2, '118.5', 'up')).toThrow(RangeError);
    expect(() => usdToSyp(1, '0', 'up')).toThrow(RangeError);
    expect(() => sypToUsd(1, 'abc', 'up')).toThrow(RangeError);
  });

  it('refuses a result beyond the largest safe integer instead of losing precision', () => {
    expect(() => usdToSyp(Number.MAX_SAFE_INTEGER, '99999999.9999', 'up')).toThrow(RangeError);
  });
});

describe('rounding to a step', () => {
  it('rounds up to the next multiple of the step', () => {
    expect(ceilToStep(0, 500)).toBe(0);
    expect(ceilToStep(1, 500)).toBe(500);
    expect(ceilToStep(500, 500)).toBe(500);
    expect(ceilToStep(501, 500)).toBe(1_000);
    expect(ceilToStep(1_001_000, USD_CENT)).toBe(1_010_000);
  });

  it('refuses a step that is not a positive integer, or a negative amount', () => {
    expect(() => ceilToStep(100, 0)).toThrow(RangeError);
    expect(() => ceilToStep(100, -5)).toThrow(RangeError);
    expect(() => ceilToStep(100, 2.5)).toThrow(RangeError);
    expect(() => ceilToStep(-1, 500)).toThrow(RangeError);
  });

  it('refuses a result beyond the largest safe integer', () => {
    expect(() => ceilToStep(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });
});

describe('SYP display price', () => {
  it('is USD × rate rounded up to the step (ADR 0003: 5 SYP at about 118 SYP per USD)', () => {
    // $0.99 × 118.5 = 117.315 SYP → 120 SYP.
    expect(sypDisplayPrice(990_000, '118.5', 500)).toBe(12_000);
    // $10 × 118.5 = 1,185 SYP, already on the step.
    expect(sypDisplayPrice(10_000_000, '118.5', 500)).toBe(118_500);
    // One micro-dollar above the step still rounds up: the shown price never undercharges.
    expect(sypDisplayPrice(10_000_000 + 1, '118.5', 500)).toBe(119_000);
  });
});
