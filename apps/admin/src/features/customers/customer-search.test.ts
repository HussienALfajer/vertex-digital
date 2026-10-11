import { describe, expect, it } from 'vitest';
import { limitInput, parseLimitInput, statusChips } from './customer-labels';
import { parseCustomerSearch, parseCustomerTab, withStatus, withText } from './customer-search';

describe('parseCustomerSearch', () => {
  it('keeps a trimmed text and a status tab', () => {
    expect(parseCustomerSearch({ q: ' VO-7KQ2MX ', status: 'frozen' })).toEqual({
      q: 'VO-7KQ2MX',
      status: 'frozen',
    });
  });

  it('drops "all", unknown statuses and empty or long texts', () => {
    expect(parseCustomerSearch({ status: 'all', q: '  ' })).toEqual({});
    expect(parseCustomerSearch({ status: 'deleted', q: 'x'.repeat(101) })).toEqual({});
  });
});

describe('withStatus and withText', () => {
  it('keeps the other part of the search', () => {
    expect(withStatus({ q: 'sara' }, 'test')).toEqual({ q: 'sara', status: 'test' });
    expect(withStatus({ q: 'sara', status: 'test' }, 'all')).toEqual({ q: 'sara' });
    expect(withText({ status: 'frozen', q: 'old' }, ' new ')).toEqual({
      status: 'frozen',
      q: 'new',
    });
    expect(withText({ status: 'frozen', q: 'old' }, '')).toEqual({ status: 'frozen' });
  });
});

describe('parseCustomerTab', () => {
  it('keeps a known tab but the summary', () => {
    expect(parseCustomerTab({ tab: 'notes' })).toEqual({ tab: 'notes' });
    expect(parseCustomerTab({ tab: 'summary' })).toEqual({});
    expect(parseCustomerTab({ tab: 'secrets' })).toEqual({});
  });
});

describe('statusChips', () => {
  it('shows archived, frozen and test, nothing for an active customer', () => {
    expect(statusChips('active', false)).toEqual([]);
    expect(statusChips('frozen', true)).toEqual(['frozen', 'test']);
    expect(statusChips('archived', false)).toEqual(['archived']);
  });
});

describe('limit fields', () => {
  it('reads dollars as USD units, empty as cleared, anything else as invalid', () => {
    expect(parseLimitInput('500')).toBe(500_000_000);
    expect(parseLimitInput('12.5')).toBe(12_500_000);
    expect(parseLimitInput('  ')).toBeNull();
    expect(parseLimitInput('1.005')).toBeUndefined();
    expect(parseLimitInput('-3')).toBeUndefined();
  });

  it('shows an override as dollars and none as empty', () => {
    expect(limitInput(500_000_000)).toBe('500');
    expect(limitInput(12_500_000)).toBe('12.50');
    expect(limitInput(null)).toBe('');
  });
});
