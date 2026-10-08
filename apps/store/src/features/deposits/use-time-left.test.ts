import { describe, expect, it } from 'vitest';
import { formatClock } from './use-time-left';

describe('formatClock', () => {
  it('writes minutes and seconds, and hours once past one', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(14 * 60 + 5)).toBe('14:05');
    expect(formatClock(3 * 3600 + 14 * 60 + 5)).toBe('3:14:05');
  });
});
