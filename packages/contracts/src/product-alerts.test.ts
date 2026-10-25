import { describe, expect, it } from 'vitest';
import {
  alertDue,
  createProductAlertSchema,
  productAlertListQuerySchema,
  productAlertRefusal,
} from './product-alerts.js';

const LIST = '0199a000-0000-7000-8000-000000000001';
const OTHER_LIST = '0199a000-0000-7000-8000-000000000002';

describe('setting an alert (PA1)', () => {
  it('refuses a hidden pack whatever the kind', () => {
    const hidden = { hidden: true, available: true, unitPriceUsdUnits: 1_000_000 };
    expect(productAlertRefusal('available', hidden)).toBe('hidden');
    expect(productAlertRefusal('price_drop', hidden)).toBe('hidden');
  });

  it('takes an availability alert only on an unavailable pack', () => {
    const pack = { hidden: false, available: true, unitPriceUsdUnits: 1_000_000 };
    expect(productAlertRefusal('available', pack)).toBe('available');
    expect(
      productAlertRefusal('available', { ...pack, available: false, unitPriceUsdUnits: null }),
    ).toBeNull();
  });

  it('takes a price-drop alert only on an available pack with a price', () => {
    const pack = { hidden: false, available: true, unitPriceUsdUnits: 1_000_000 };
    expect(productAlertRefusal('price_drop', pack)).toBeNull();
    expect(productAlertRefusal('price_drop', { ...pack, unitPriceUsdUnits: null })).toBe(
      'unavailable',
    );
    expect(productAlertRefusal('price_drop', { ...pack, available: false })).toBe('unavailable');
  });

  it('reads the inputs', () => {
    expect(() =>
      createProductAlertSchema.parse({ productId: LIST, kind: 'price_drop' }),
    ).not.toThrow();
    expect(() => createProductAlertSchema.parse({ productId: LIST, kind: 'target' })).toThrow();
    expect(productAlertListQuerySchema.parse({})).toEqual({ status: 'active' });
  });
});

describe('due alerts (PA3–PA5)', () => {
  const drop = {
    kind: 'price_drop' as const,
    baselinePriceUsdUnits: 3_500_000,
    priceListId: LIST,
  };
  const back = { kind: 'available' as const, baselinePriceUsdUnits: null, priceListId: LIST };
  const current = (unitPriceUsdUnits: number | null, available = true, priceListId = LIST) => ({
    priceListId,
    available,
    unitPriceUsdUnits,
  });

  it('sends an availability alert once the pack is available', () => {
    expect(alertDue(back, current(1_000_000))).toBe('available');
    expect(alertDue(back, current(null, false))).toBeNull();
  });

  it('sends a price drop strictly below the baseline only', () => {
    expect(alertDue(drop, current(3_490_000))).toBe('price_dropped');
    expect(alertDue(drop, current(3_500_000))).toBeNull();
    expect(alertDue(drop, current(3_600_000))).toBeNull();
    expect(alertDue(drop, current(3_000_000, false))).toBeNull();
    expect(alertDue(drop, current(null))).toBeNull();
    expect(alertDue({ ...drop, baselinePriceUsdUnits: null }, current(1_000_000))).toBeNull();
  });

  it('rebases an alert whose list is no longer the customer list, whatever the price', () => {
    expect(alertDue(drop, current(1_000_000, true, OTHER_LIST))).toBe('rebase');
    expect(alertDue(back, current(1_000_000, true, OTHER_LIST))).toBe('rebase');
  });
});
