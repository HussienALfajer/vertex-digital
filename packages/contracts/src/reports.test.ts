import { describe, expect, it } from 'vitest';
import {
  REPORT_KINDS,
  REPORT_MAX_DAYS,
  REPORT_SCHEMAS,
  reportPeriodDays,
  reportPeriodError,
  reportQuerySchema,
} from './reports.js';

describe('report periods (rule RP1)', () => {
  it('counts both ends and refuses a reversed or too long period', () => {
    expect(reportPeriodDays('2026-10-01', '2026-10-01')).toBe(1);
    expect(reportPeriodDays('2026-03-01', '2026-03-31')).toBe(31);
    expect(reportPeriodError('2026-10-02', '2026-10-01')).toBe('REPORT_PERIOD_INVALID');
    expect(reportPeriodError('2025-10-01', '2026-10-01')).toBeNull();
    expect(reportPeriodDays('2025-10-01', '2026-10-01')).toBe(366);
    expect(REPORT_MAX_DAYS).toBe(366);
    expect(reportPeriodError('2025-10-01', '2026-10-02')).toBe('REPORT_PERIOD_INVALID');
  });

  it('takes ISO dates and an optional breakdown', () => {
    expect(reportQuerySchema.parse({ from: '2026-10-01', to: '2026-10-11' }).by).toBeUndefined();
    expect(reportQuerySchema.safeParse({ from: '2026-10-1', to: '2026-10-11' }).success).toBe(
      false,
    );
    expect(
      reportQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-11', by: 'x' }).success,
    ).toBe(false);
  });

  it('has a response schema per kind', () => {
    expect(Object.keys(REPORT_SCHEMAS).sort()).toEqual([...REPORT_KINDS].sort());
  });
});
