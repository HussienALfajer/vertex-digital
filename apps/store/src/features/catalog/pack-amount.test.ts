import { describe, expect, it } from 'vitest';
import { packAmountText } from './pack-amount';

describe('packAmountText (rule SF2, audit A9)', () => {
  it('is hidden when the name already says the amount', () => {
    expect(packAmountText('60 شدة', 60)).toBeNull();
    expect(packAmountText('1,800 شدة', 1800)).toBeNull();
    expect(packAmountText('8,100 شدة', 8100)).toBeNull();
  });

  it('shows the amount a name does not say, with Latin separators', () => {
    expect(packAmountText('800 + 160 نقطة CP', 960)).toBe('960');
    expect(packAmountText('4,000 + 1,400 نقطة CP', 5400)).toBe('5,400');
    expect(packAmountText('الباقة الأساسية', 60)).toBe('60');
  });

  it('shows nothing without an amount', () => {
    expect(packAmountText('بطاقة 10$', null)).toBeNull();
  });
});
