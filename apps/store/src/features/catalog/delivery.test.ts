import { describe, expect, it } from 'vitest';
import { deliveryChipText, deliveryDetailText, formatDuration } from './delivery';

describe('formatDuration (rule SF3)', () => {
  it('rounds up to seconds under a minute, minutes under an hour, then hours', () => {
    expect(formatDuration(0)).toBe('ثانية واحدة');
    expect(formatDuration(1_200)).toBe('ثانيتين');
    expect(formatDuration(3_000)).toBe('3 ثوانٍ');
    expect(formatDuration(39_100)).toBe('40 ثانية');
    expect(formatDuration(59_999)).toBe('دقيقة واحدة');
    expect(formatDuration(61_000)).toBe('دقيقتين');
    expect(formatDuration(10 * 60_000)).toBe('10 دقائق');
    expect(formatDuration(59 * 60_000 + 1)).toBe('ساعة واحدة');
    expect(formatDuration(3 * 3_600_000)).toBe('3 ساعات');
    expect(formatDuration(30 * 3_600_000)).toBe('30 ساعة');
  });

  it('writes the chip and the buy box line, or says there is no data', () => {
    const stats = { medianMs: 40_000, p90Ms: 95_000, count: 12 };
    expect(deliveryChipText(stats)).toBe('خلال 40 ثانية عادةً');
    expect(deliveryChipText(null)).toBeNull();
    expect(deliveryDetailText(stats)).toBe('9 من كل 10 طلبات خلال دقيقتين');
    expect(deliveryDetailText(null)).toBe('لا بيانات كافية بعد عن وقت التسليم');
  });
});
