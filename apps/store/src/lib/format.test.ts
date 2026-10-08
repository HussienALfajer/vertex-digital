import { describe, expect, it } from 'vitest';
import { formatDate, formatRelative } from './format';

describe('formatRelative', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it('says minutes, hours and days ago in Arabic with Latin digits', () => {
    expect(formatRelative(ago(10), now)).toBe('هذه الدقيقة');
    expect(formatRelative(ago(5 * 60), now)).toBe('قبل 5 دقائق');
    expect(formatRelative(ago(3 * 60 * 60), now)).toBe('قبل 3 ساعات');
    expect(formatRelative(ago(24 * 60 * 60), now)).toBe('أمس');
  });

  it('shows the date after a week', () => {
    expect(formatRelative(ago(8 * 24 * 60 * 60), now)).toBe(formatDate(ago(8 * 24 * 60 * 60)));
  });
});
