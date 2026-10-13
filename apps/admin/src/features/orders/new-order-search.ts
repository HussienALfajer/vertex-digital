import { ADMIN_ORDER_PURPOSES, type AdminOrderPurpose } from '@vertex-digital/contracts';

/*
 * "/orders/new" presets (S16 screens): the mode, the customer (the profile's "شراء لهذا الزبون")
 * and the pack (the game page's "شراء"), from the URL. Anything invalid is dropped.
 */

export interface NewOrderSearch {
  purpose?: AdminOrderPurpose;
  customerId?: string;
  gameId?: string;
  productId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNewOrderSearch(search: Record<string, unknown>): NewOrderSearch {
  const parsed: NewOrderSearch = {};
  if ((ADMIN_ORDER_PURPOSES as readonly unknown[]).includes(search.purpose)) {
    parsed.purpose = search.purpose as AdminOrderPurpose;
  }
  for (const key of ['customerId', 'gameId', 'productId'] as const) {
    const value = search[key];
    if (typeof value === 'string' && UUID.test(value)) parsed[key] = value;
  }
  // A walk-in order has no customer.
  if (parsed.purpose === 'walk_in') delete parsed.customerId;
  return parsed;
}
