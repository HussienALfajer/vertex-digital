import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './system.js';

describe('health response', () => {
  it('accepts a report and refuses an unknown check state', () => {
    const report = {
      status: 'ok',
      checks: { database: 'up' },
      timestamp: '2026-10-07T10:00:00.000Z',
    };
    expect(healthResponseSchema.parse(report)).toEqual(report);
    expect(
      healthResponseSchema.safeParse({ ...report, checks: { database: 'maybe' } }).success,
    ).toBe(false);
  });
});
