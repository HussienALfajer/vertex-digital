import { describe, expect, it } from 'vitest';
import {
  damascusToday,
  parseReportSearch,
  periodOf,
  presetOf,
  presetPeriod,
  withKind,
} from './report-search';

// 2026-10-10 22:30 UTC is already 2026-10-11 in Damascus (UTC+3).
const NOW = new Date('2026-10-10T22:30:00Z');

describe('report periods (S13 rule RP1)', () => {
  it('counts days in Damascus', () => {
    expect(damascusToday(NOW)).toBe('2026-10-11');
  });

  it('computes the presets', () => {
    expect(presetPeriod('today', NOW)).toEqual({ from: '2026-10-11', to: '2026-10-11' });
    expect(presetPeriod('yesterday', NOW)).toEqual({ from: '2026-10-10', to: '2026-10-10' });
    expect(presetPeriod('last7', NOW)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(presetPeriod('thisMonth', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-11' });
    expect(presetPeriod('lastMonth', NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetPeriod('lastMonth', new Date('2026-03-15T10:00:00Z'))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('names the preset a period matches, or none', () => {
    expect(presetOf({ from: '2026-10-05', to: '2026-10-11' }, NOW)).toBe('last7');
    expect(presetOf({ from: '2026-10-02', to: '2026-10-11' }, NOW)).toBeNull();
    expect(periodOf({}, NOW)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });
});

describe('parseReportSearch', () => {
  it('keeps a valid report, period and breakdown', () => {
    expect(
      parseReportSearch({
        kind: 'breakdown',
        from: '2026-10-01',
        to: '2026-10-11',
        by: 'supplier',
      }),
    ).toEqual({ kind: 'breakdown', from: '2026-10-01', to: '2026-10-11', by: 'supplier' });
  });

  it('drops the defaults and anything invalid', () => {
    expect(parseReportSearch({ kind: 'sales', by: 'supplier' })).toEqual({});
    expect(parseReportSearch({ kind: 'nope', from: '2026-10-11', to: '2026-10-01' })).toEqual({});
    expect(parseReportSearch({ kind: 'ledger', from: '2025-01-01', to: '2026-10-11' })).toEqual({
      kind: 'ledger',
    });
    expect(parseReportSearch({ kind: 'deposits', by: 'supplier' })).toEqual({ kind: 'deposits' });
    expect(parseReportSearch({ kind: 'breakdown', by: 'game' })).toEqual({ kind: 'breakdown' });
  });

  it('keeps the period across reports, the breakdown only on R2', () => {
    const search = {
      kind: 'breakdown' as const,
      from: '2026-10-01',
      to: '2026-10-11',
      by: 'product' as const,
    };
    expect(withKind(search, 'sales')).toEqual({ from: '2026-10-01', to: '2026-10-11' });
    expect(withKind(search, 'ledger')).toEqual({
      kind: 'ledger',
      from: '2026-10-01',
      to: '2026-10-11',
    });
    expect(withKind({ kind: 'ledger' }, 'breakdown')).toEqual({ kind: 'breakdown' });
  });
});
