import { describe, expect, it } from 'vitest';
import { formatDay, formatDuration, formatSince } from './format';

describe('formatSince', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  it('uses the largest whole unit, with Latin digits', () => {
    expect(formatSince(ago(12), now)).toMatch(/12/);
    expect(formatSince(ago(12), now)).toMatch(/دقيقة/);
    expect(formatSince(ago(3 * 60 + 5), now)).toMatch(/3 ساعات/);
    expect(formatSince(ago(3 * 24 * 60), now)).toMatch(/3 أيام/);
  });

  it('never reads as the future', () => {
    expect(formatSince(ago(-5), now)).toBe(formatSince(ago(0), now));
  });
});

describe('formatDuration (S08 rule T1)', () => {
  it('reads seconds, minutes, then hours', () => {
    expect(formatDuration(44_600)).toBe('45 ث');
    expect(formatDuration(210_000)).toBe('3.5 د');
    expect(formatDuration(60_000)).toBe('1 د');
    expect(formatDuration(7_200_000)).toBe('2 س');
  });
});

describe('formatDay (S13)', () => {
  it('shows a stored calendar day as that day, with Latin digits', () => {
    const shown = formatDay('2026-10-10');
    expect(shown).toContain('10');
    expect(shown).toContain('2026');
    expect(formatDay('2026-10-01')).not.toContain('30');
  });
});
