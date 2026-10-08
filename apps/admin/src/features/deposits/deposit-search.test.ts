import { describe, expect, it } from 'vitest';
import { parseDepositSearch, tabOf, withMethod, withTab } from './deposit-search';
import { parseTransferSearch } from './transfer-search';

describe('the deposits search', () => {
  it('opens the queue by default', () => {
    expect(parseDepositSearch({})).toEqual({});
    expect(parseDepositSearch({ status: 'submitted' })).toEqual({});
    expect(parseDepositSearch({ status: 'credited' })).toEqual({});
    expect(tabOf({})).toBe('submitted');
  });

  it('keeps a known tab and a search of 3 characters or more', () => {
    expect(parseDepositSearch({ status: 'all', q: ' vd-7kq2m ' })).toEqual({
      status: 'all',
      q: 'vd-7kq2m',
    });
    expect(parseDepositSearch({ status: 'pending', q: 'sa' })).toEqual({ status: 'pending' });
    expect(parseDepositSearch({ q: 42 })).toEqual({});
    expect(tabOf({ status: 'pending' })).toBe('pending');
  });

  it('changes the tab and keeps the text', () => {
    expect(withTab({ q: 'sara' }, 'all')).toEqual({ status: 'all', q: 'sara' });
    expect(withTab({ status: 'all' }, 'submitted')).toEqual({});
  });

  it('keeps a known method across tabs, and clears it', () => {
    expect(parseDepositSearch({ method: 'usdt_trc20', status: 'all' })).toEqual({
      method: 'usdt_trc20',
      status: 'all',
    });
    expect(parseDepositSearch({ method: 'paypal' })).toEqual({});
    expect(withTab({ method: 'usdt_bep20', status: 'all' }, 'submitted')).toEqual({
      method: 'usdt_bep20',
    });
    expect(withMethod({ status: 'pending', method: 'sham_cash' }, null)).toEqual({
      status: 'pending',
    });
    expect(withMethod({}, 'usdt_trc20')).toEqual({ method: 'usdt_trc20' });
  });
});

describe('the USDT transfers search', () => {
  it('shows the unmatched transfers of every network by default', () => {
    expect(parseTransferSearch({})).toEqual({});
    expect(parseTransferSearch({ state: 'unmatched', method: 'sham_cash' })).toEqual({});
    expect(parseTransferSearch({ state: 'all', method: 'usdt_bep20' })).toEqual({
      state: 'all',
      method: 'usdt_bep20',
    });
  });
});
