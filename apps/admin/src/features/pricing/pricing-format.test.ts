import { describe, expect, it } from 'vitest';
import { formatPercentBp, parseCostUsd, parsePercentBp, ruleTexts } from './pricing-format';

describe('parsePercentBp', () => {
  it('reads whole and decimal percents as basis points', () => {
    expect(parsePercentBp('10')).toBe(1000);
    expect(parsePercentBp(' 12.5 ')).toBe(1250);
    expect(parsePercentBp('0.25')).toBe(25);
    expect(parsePercentBp('0')).toBe(0);
    expect(parsePercentBp('100')).toBe(10_000);
  });

  it('refuses anything else', () => {
    for (const text of ['', '100.01', '101', '-1', '1.234', '1,5', '١٠', 'abc']) {
      expect(parsePercentBp(text)).toBeNull();
    }
  });
});

describe('formatPercentBp', () => {
  it('is the inverse of parsePercentBp', () => {
    expect(formatPercentBp(1000)).toBe('10');
    expect(formatPercentBp(1250)).toBe('12.5');
    expect(formatPercentBp(25)).toBe('0.25');
    expect(formatPercentBp(0)).toBe('0');
    for (const bp of [1, 99, 101, 1205, 10_000]) {
      expect(parsePercentBp(formatPercentBp(bp))).toBe(bp);
    }
  });
});

describe('parseCostUsd', () => {
  it('reads dollars to the micro-dollar', () => {
    expect(parseCostUsd('0.89')).toBe(890_000);
    expect(parseCostUsd('0.8875')).toBe(887_500);
    expect(parseCostUsd('0.000001')).toBe(1);
    expect(parseCostUsd('10000')).toBe(10_000_000_000);
  });

  it('refuses anything else', () => {
    for (const text of ['', '0.0000001', '100000', '-1', '1,5', '$1', 'abc']) {
      expect(parseCostUsd(text)).toBeNull();
    }
  });
});

describe('ruleTexts', () => {
  it('shows a rule as the form edits it', () => {
    expect(ruleTexts({ percentBp: 1200, fixedUsdUnits: 0, minMarginUsdUnits: 150_000 })).toEqual({
      percent: '12',
      fixed: '0.00',
      minimum: '0.15',
    });
  });
});
