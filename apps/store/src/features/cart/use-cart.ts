'use client';

import { useSyncExternalStore } from 'react';
import { type CartLine, readCart } from './cart';
import { CART_KEY, subscribeCart } from './cart-keys';

/*
 * The cart as React reads it (rule CT1): the same snapshot until the stored text changes, null
 * without storage, and `undefined` while rendering on the server (the cart lives on the device).
 */

let lastRaw: string | null | undefined;
let lastLines: CartLine[] | null = [];

function snapshot(): CartLine[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CART_KEY);
  } catch {
    return null;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastLines = readCart();
  }
  return lastLines;
}

export function useCart(): CartLine[] | null | undefined {
  return useSyncExternalStore(subscribeCart, snapshot, () => undefined);
}
