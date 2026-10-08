import { describe, expect, it } from 'vitest';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  ceilToStep,
  currencySchema,
  exchangeRateSchema,
  floorToWholeCents,
  formatAmountInput,
  formatRate,
  formatSignedUsd,
  formatSyp,
  formatUsd,
  formatUsdtAmount,
  isSameRate,
  isWholeCents,
  parseUsd,
  parseWholeSyp,
  rateChangePercent,
  rateFromNumeric,
  rawToUsdUnits,
  sypDepositUsd,
  sypDisplayPrice,
  sypToUsd,
  USD_CENT,
  usdCentsSchema,
  usdToSyp,
  usdtRawForUnits,
  walletSypValue,
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

describe('walletSypValue (S02 rule W9)', () => {
  it('rounds the balance down to the step, so it never shows more than the customer holds', () => {
    // $12.34 × 118.5 = 1,462.29 SYP; a step of 5 SYP shows 1,460.
    expect(walletSypValue(12_340_000, '118.5', 500)).toBe(146_000);
    // Already on the step.
    expect(walletSypValue(10_000_000, '118.5', 500)).toBe(118_500);
    // One micro-dollar below the step rounds down to the step below.
    expect(walletSypValue(10_000_000 - 1, '118.5', 500)).toBe(118_000);
  });

  it('shows zero for an empty wallet and stays exact for large balances', () => {
    expect(walletSypValue(0, '118.5', 500)).toBe(0);
    // $1,000,000,000 × 13,000.25 SYP, exact in BigInt.
    expect(walletSypValue(1_000_000_000 * CURRENCY_SCALE.USD, '13000.25', 100)).toBe(
      1_300_025_000_000_000,
    );
  });

  it('refuses a step that is not a positive integer', () => {
    expect(() => walletSypValue(1_000_000, '118.5', 0)).toThrow(RangeError);
    expect(() => walletSypValue(1_000_000, '118.5', 2.5)).toThrow(RangeError);
  });
});

describe('formatUsd', () => {
  it('shows dollars and cents with Latin digits and grouping', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12_500_000)).toBe('$12.50');
    expect(formatUsd(1_234_567_890_000)).toBe('$1,234,567.89');
    expect(formatUsd(-250_000)).toBe('-$0.25');
  });

  it('keeps sub-cent precision when there is some', () => {
    expect(formatUsd(125)).toBe('$0.000125');
    expect(formatUsd(-1_234_500)).toBe('-$1.2345');
  });

  it('refuses a non-integer amount', () => {
    expect(() => formatUsd(1.5)).toThrow(RangeError);
  });
});

describe('parseUsd', () => {
  it('reads dollars with up to 2 decimals, exactly', () => {
    expect(parseUsd('25')).toBe(25_000_000);
    expect(parseUsd(' 25.5 ')).toBe(25_500_000);
    expect(parseUsd('0.01')).toBe(USD_CENT);
    expect(parseUsd('100.10')).toBe(100_100_000);
    expect(parseUsd('999999999.99')).toBe(999_999_999_990_000);
  });

  it('refuses anything else', () => {
    for (const text of ['', '.5', '1.', '1.234', '-1', '1,000', '1e3', '١٢', '1000000000']) {
      expect(parseUsd(text)).toBeNull();
    }
  });
});

describe('formatSignedUsd', () => {
  it('signs money in with a plus and money out with a minus sign', () => {
    expect(formatSignedUsd(25_000_000)).toBe('+$25.00');
    expect(formatSignedUsd(-1_250_000)).toBe('−$1.25');
  });
});

describe('rate comparison (S03 rule FX2)', () => {
  it('compares rates by value', () => {
    expect(isSameRate('130', '130.0000')).toBe(true);
    expect(isSameRate('130', '130.0001')).toBe(false);
    expect(isSameRate('abc', 'abc')).toBe(false);
  });

  it('gives the change in percent of the old rate, rounded away from zero', () => {
    expect(rateChangePercent('100', '105')).toBe('5.00');
    expect(rateChangePercent('100', '105.0001')).toBe('5.01');
    expect(rateChangePercent('100', '94.9999')).toBe('-5.01');
    expect(rateChangePercent('118', '130')).toBe('10.17');
    expect(rateChangePercent('118', '1180')).toBe('900.00');
    expect(rateChangePercent('118', '118')).toBe('0.00');
    expect(rateChangePercent('100', '99.99')).toBe('-0.01');
  });

  it('refuses invalid rates', () => {
    expect(() => rateChangePercent('0', '1')).toThrow(RangeError);
  });
});

describe('deposit credits (S03 rules FX6, M3)', () => {
  it('floors USD units to whole cents', () => {
    expect(floorToWholeCents(0)).toBe(0);
    expect(floorToWholeCents(9_999)).toBe(0);
    expect(floorToWholeCents(10_000)).toBe(10_000);
    expect(floorToWholeCents(16_949_152)).toBe(16_940_000);
    expect(() => floorToWholeCents(-1)).toThrow(RangeError);
  });

  it('converts pounds down, then floors to whole cents', () => {
    // 2,000 SYP at 118 is $16.949152…: $16.94.
    expect(sypDepositUsd(200_000, '118')).toBe(16_940_000);
    // Exactly whole: 1,180 SYP at 118 is $10.00.
    expect(sypDepositUsd(118_000, '118')).toBe(10_000_000);
    // One pound short of a cent boundary stays below it.
    expect(sypDepositUsd(117_900, '118')).toBe(9_990_000);
    // A tiny amount is worth no whole cent (edge case 13).
    expect(sypDepositUsd(100, '130')).toBe(0);
    expect(sypDepositUsd(200_000, '118.5')).toBe(16_870_000);
  });
});

describe('rateFromNumeric', () => {
  it("drops the trailing zeros PostgreSQL writes, never a whole number's", () => {
    expect(rateFromNumeric('118.5000')).toBe('118.5');
    expect(rateFromNumeric('120.0000')).toBe('120');
    expect(rateFromNumeric('100.0500')).toBe('100.05');
    expect(rateFromNumeric('100')).toBe('100');
  });
});

describe('SYP and rate display (S03)', () => {
  it('formats pounds with grouping, decimals only for a fraction', () => {
    expect(formatSyp(200_000)).toBe('2,000');
    expect(formatSyp(125_050)).toBe('1,250.50');
    expect(formatSyp(5)).toBe('0.05');
    expect(formatSyp(0)).toBe('0');
    expect(() => formatSyp(-1)).toThrow(RangeError);
  });

  it('formats a rate with its whole part grouped', () => {
    expect(formatRate('13000')).toBe('13,000');
    expect(formatRate('118.5')).toBe('118.5');
    expect(formatRate('1180.25')).toBe('1,180.25');
    expect(() => formatRate('abc')).toThrow(RangeError);
  });

  it('reads whole pounds only', () => {
    expect(parseWholeSyp('2000')).toBe(200_000);
    expect(parseWholeSyp(' 15 ')).toBe(1_500);
    for (const text of ['', '1.5', '-1', '1,000', '١٢', '1e3', '1234567890123']) {
      expect(parseWholeSyp(text)).toBeNull();
    }
  });
});

describe('formatAmountInput (S03)', () => {
  it('writes whole pounds and dollars back as typed, exactly', () => {
    expect(formatAmountInput('SYP', 200_000)).toBe('2000');
    expect(formatAmountInput('USD', 25_000_000)).toBe('25');
    expect(formatAmountInput('USD', 25_500_000)).toBe('25.50');
    expect(formatAmountInput('USD', 10_000)).toBe('0.01');
    expect(parseUsd(formatAmountInput('USD', 1_250_050_000))).toBe(1_250_050_000);
  });

  it('refuses a fraction of a pound or a cent instead of rounding', () => {
    expect(() => formatAmountInput('SYP', 200_050)).toThrow(RangeError);
    expect(() => formatAmountInput('USD', 25_000_001)).toThrow(RangeError);
    expect(() => formatAmountInput('USD', -1)).toThrow(RangeError);
  });
});

describe('USDT amounts (S04 rules U3, U7, M2)', () => {
  it('formats with at least 4 decimals, more only for finer amounts', () => {
    expect(formatUsdtAmount(25_003_700)).toBe('25.0037');
    expect(formatUsdtAmount(10_000_000)).toBe('10.0000');
    expect(formatUsdtAmount(24_003_712)).toBe('24.003712');
    expect(formatUsdtAmount(1_234_567_890_000)).toBe('1234567.8900');
    expect(() => formatUsdtAmount(-1)).toThrow(RangeError);
  });

  it('converts raw amounts at 6 decimals exactly', () => {
    expect(rawToUsdUnits(25_003_700n, 6)).toBe(25_003_700);
    expect(usdtRawForUnits(25_003_700, 6)).toBe(25_003_700n);
  });

  it('converts raw amounts at 18 decimals, flooring a remainder below a micro-unit', () => {
    const raw = usdtRawForUnits(25_003_700, 18);
    expect(raw).toBe(25_003_700_000_000_000_000n);
    expect(rawToUsdUnits(raw, 18)).toBe(25_003_700);
    expect(rawToUsdUnits(raw + 999_999_999_999n, 18)).toBe(25_003_700);
    expect(rawToUsdUnits(raw - 1n, 18)).toBe(25_003_699);
    expect(usdtRawForUnits(rawToUsdUnits(raw + 1n, 18), 18)).not.toBe(raw + 1n);
  });

  it('refuses negative amounts, unsafe results and unsupported decimals', () => {
    expect(() => rawToUsdUnits(-1n, 6)).toThrow(RangeError);
    expect(() => rawToUsdUnits(10n ** 30n, 6)).toThrow(RangeError);
    expect(() => rawToUsdUnits(1n, 5)).toThrow(RangeError);
    expect(() => rawToUsdUnits(1n, 37)).toThrow(RangeError);
    expect(() => usdtRawForUnits(1, 6.5)).toThrow(RangeError);
    expect(() => usdtRawForUnits(-1, 6)).toThrow(RangeError);
  });
});
