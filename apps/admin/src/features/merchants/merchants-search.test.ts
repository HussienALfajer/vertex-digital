import { describe, expect, it } from 'vitest';
import { parseApplicationsSearch, parseMerchantsSearch, statusOf, tabOf } from './merchants-search';

describe('merchant searches in the URL (S20 screens)', () => {
  it('keep a known tab, under review by default', () => {
    expect(parseApplicationsSearch({ tab: 'all' })).toEqual({ tab: 'all' });
    expect(parseApplicationsSearch({ tab: 'under_review' })).toEqual({});
    expect(parseApplicationsSearch({ tab: 'nope' })).toEqual({});
    expect(tabOf({})).toBe('under_review');
    expect(statusOf('info_requested')).toBe('info_requested');
    expect(statusOf('all')).toBeUndefined();
  });

  it('keep a trimmed search and a list id', () => {
    const listId = '0199e000-0000-7000-8000-000000000001';
    expect(parseMerchantsSearch({ q: '  نور ', listId })).toEqual({ q: 'نور', listId });
    expect(parseMerchantsSearch({ q: ' ', listId: 'x' })).toEqual({});
  });

  it('keep a known tier or granted (S23 AD1)', () => {
    expect(parseMerchantsSearch({ tier: 'gold' })).toEqual({ tier: 'gold' });
    expect(parseMerchantsSearch({ tier: 'granted' })).toEqual({ tier: 'granted' });
    expect(parseMerchantsSearch({ tier: 'platinum' })).toEqual({});
    expect(parseMerchantsSearch({ tier: 3 })).toEqual({});
  });
});
