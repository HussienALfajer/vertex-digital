import { describe, expect, it } from 'vitest';
import { parseNewTicketSearch, parseSupportSearch, tabOf, withFilter } from './support-search';

const CUSTOMER = '0199a000-0000-7000-8000-000000000010';

describe('parseSupportSearch', () => {
  it('keeps the tab, the type, the customer and the number', () => {
    expect(
      parseSupportSearch({
        status: 'closed',
        category: 'order',
        customerId: CUSTOMER,
        q: ' vt-7kq ',
      }),
    ).toEqual({ status: 'closed', category: 'order', customerId: CUSTOMER, q: 'vt-7kq' });
  });

  it('drops the queue tab and anything invalid', () => {
    expect(
      parseSupportSearch({ status: 'open', category: 'refund', customerId: 'x', q: '' }),
    ).toEqual({});
  });
});

describe('withFilter', () => {
  it('clears the queue tab and undefined filters, keeping the others', () => {
    const search = { status: 'all' as const, category: 'deposit' as const, q: 'VT-1' };
    expect(withFilter(search, { status: 'open' })).toEqual({ category: 'deposit', q: 'VT-1' });
    expect(withFilter(search, { category: undefined })).toEqual({ status: 'all', q: 'VT-1' });
    expect(tabOf({})).toBe('open');
  });
});

describe('parseNewTicketSearch', () => {
  it('keeps a customer id only', () => {
    expect(parseNewTicketSearch({ customer: CUSTOMER })).toEqual({ customer: CUSTOMER });
    expect(parseNewTicketSearch({ customer: 'sara' })).toEqual({});
  });
});
