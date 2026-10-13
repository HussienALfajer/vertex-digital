import { describe, expect, it } from 'vitest';
import { parseNewOrderSearch } from './new-order-search';

const id = '0199c3a4-0000-7000-8000-000000000001';

describe('parseNewOrderSearch', () => {
  it('keeps the mode, the customer and the pack', () => {
    expect(
      parseNewOrderSearch({ purpose: 'gift', customerId: id, gameId: id, productId: id }),
    ).toEqual({ purpose: 'gift', customerId: id, gameId: id, productId: id });
  });

  it('drops anything invalid, and a customer on a walk-in order', () => {
    expect(parseNewOrderSearch({ purpose: 'sale', customerId: 'x', productId: 3 })).toEqual({});
    expect(parseNewOrderSearch({ purpose: 'walk_in', customerId: id })).toEqual({
      purpose: 'walk_in',
    });
  });
});
