import { describe, expect, it } from 'vitest';
import { formatSince } from './format';

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
