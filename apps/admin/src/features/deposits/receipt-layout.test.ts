import { describe, expect, it } from 'vitest';
import { receiptLayout } from './receipt-layout';

describe('receiptLayout (F4-2)', () => {
  it('fits an upright receipt to the frame width, scaled by the zoom', () => {
    expect(receiptLayout(400, 2, 0, 1)).toEqual({
      width: 400,
      height: 800,
      boxWidth: 400,
      boxHeight: 800,
    });
    expect(receiptLayout(400, 2, 2, 1.5)).toEqual({
      width: 600,
      height: 1200,
      boxWidth: 600,
      boxHeight: 1200,
    });
  });

  it('fits a quarter-turned receipt across the frame and swaps its box', () => {
    // A phone screenshot twice as tall as wide, turned: its height now runs across the frame.
    expect(receiptLayout(400, 2, 1, 1)).toEqual({
      width: 200,
      height: 400,
      boxWidth: 400,
      boxHeight: 200,
    });
    expect(receiptLayout(400, 2, 3, 2)).toEqual({
      width: 400,
      height: 800,
      boxWidth: 800,
      boxHeight: 400,
    });
  });
});
