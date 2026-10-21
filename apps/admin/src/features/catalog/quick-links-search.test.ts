import { describe, expect, it } from 'vitest';
import { parseQuickLinksSearch, quickLinksRange } from './quick-links-search';

describe('the quick links page URL (S22 DL5)', () => {
  it('keeps a known period and a product id, drops the rest', () => {
    const productId = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(parseQuickLinksSearch({ days: '7', productId })).toEqual({ days: 7, productId });
    expect(parseQuickLinksSearch({ days: '90' })).toEqual({ days: 90 });
    expect(parseQuickLinksSearch({ days: '30' })).toEqual({});
    expect(parseQuickLinksSearch({ days: '31', productId: 'x' })).toEqual({});
  });

  it('reads the last days up to now', () => {
    expect(quickLinksRange(1, Date.parse('2026-10-21T12:00:00.000Z'))).toEqual({
      from: '2026-10-20T12:00:00.000Z',
      to: '2026-10-21T12:00:00.000Z',
    });
  });
});
