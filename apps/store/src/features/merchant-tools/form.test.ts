import { describe, expect, it } from 'vitest';
import {
  manualSalePrice,
  markupInput,
  parseAlertSettings,
  parseMarkup,
  parseSellingPrice,
  salePriceStart,
  sellingPriceInput,
  switchSaleCurrency,
} from './form';

describe('the selling price field (S21 PS3, owner 2026-10-30)', () => {
  const ready = { usdUnits: 5_080_000, sypUnits: 73_000 };

  it('starts in USD with the ready amount, and an untouched field saves nothing', () => {
    const start = salePriceStart(ready);
    expect(start).toEqual({ currency: 'usd', amount: '5.08', typed: false });
    expect(manualSalePrice(start, ready)).toBeNull();
    expect(salePriceStart({ usdUnits: null, sypUnits: null })).toMatchObject({ amount: '' });
  });

  it('shows the ready amount in the other currency while untouched, and still saves nothing', () => {
    const syp = switchSaleCurrency(salePriceStart(ready), 'syp', ready);
    expect(syp).toEqual({ currency: 'syp', amount: '730', typed: false });
    expect(manualSalePrice(syp, ready)).toBeNull();
    expect(switchSaleCurrency(syp, 'syp', ready)).toBe(syp);
  });

  it('clears a typed amount on a currency change: 730 SYP never becomes $730', () => {
    const typed = { currency: 'syp' as const, amount: '730', typed: true };
    const usd = switchSaleCurrency(typed, 'usd', ready);
    expect(usd).toEqual({ currency: 'usd', amount: '', typed: true });
    expect(manualSalePrice(usd, ready)).toBeNull();
  });

  it('saves a typed price as manual unless it is the ready one', () => {
    expect(manualSalePrice({ currency: 'syp', amount: '750', typed: true }, ready)).toEqual({
      currency: 'syp',
      amountUnits: 75_000,
    });
    expect(manualSalePrice({ currency: 'usd', amount: '5.08', typed: true }, ready)).toBeNull();
    expect(manualSalePrice({ currency: 'usd', amount: 'abc', typed: true }, ready)).toBeUndefined();
  });
});

describe('the merchant area fields (S21 SP1, SP2, AL5)', () => {
  it('reads a markup in percent as basis points', () => {
    expect(parseMarkup('')).toBeNull();
    expect(parseMarkup(' 10 ')).toBe(1000);
    expect(parseMarkup('12.5')).toBe(1250);
    expect(parseMarkup('0.05')).toBe(5);
    expect(parseMarkup('100')).toBe(10_000);
    expect(parseMarkup('100.01')).toBeUndefined();
    expect(parseMarkup('1.234')).toBeUndefined();
    expect(parseMarkup('ten')).toBeUndefined();
    expect(markupInput(null)).toBe('');
    expect(markupInput(1250)).toBe('12.5');
    expect(markupInput(1000)).toBe('10');
    expect(markupInput(5)).toBe('0.05');
  });

  it('reads a selling price in dollars or whole pounds', () => {
    expect(parseSellingPrice('usd', '1.25')).toEqual({ currency: 'usd', amountUnits: 1_250_000 });
    expect(parseSellingPrice('usd', '1.255')).toBeUndefined();
    expect(parseSellingPrice('usd', '0')).toBeUndefined();
    expect(parseSellingPrice('syp', '15000')).toEqual({ currency: 'syp', amountUnits: 1_500_000 });
    expect(parseSellingPrice('syp', '15000.5')).toBeUndefined();
    expect(sellingPriceInput({ currency: 'usd', amountUnits: 1_250_000 })).toBe('1.25');
    expect(sellingPriceInput({ currency: 'syp', amountUnits: 1_500_000 })).toBe('15000');
  });

  it('reads the low-balance threshold', () => {
    expect(parseAlertSettings('', true)).toEqual({ lowBalanceUsdUnits: null, dailyEmail: true });
    expect(parseAlertSettings('20', false)).toEqual({
      lowBalanceUsdUnits: 20_000_000,
      dailyEmail: false,
    });
    expect(parseAlertSettings('0.5', false)).toBeUndefined();
    expect(parseAlertSettings('abc', false)).toBeUndefined();
  });
});
