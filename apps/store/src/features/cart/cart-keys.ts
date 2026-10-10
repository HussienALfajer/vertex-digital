/*
 * The cart's storage key and change event, with what the header needs (the line count) and
 * sign-out needs (clearing it, rule CT1). No contracts import: the header ships on every page's
 * first load (apps/store/CLAUDE.md, the budgets). `cart.ts` holds the cart's rules.
 */

export const CART_KEY = 'vd-cart';
/** Sent on this tab's own changes; other tabs hear the `storage` event. */
export const CART_EVENT = 'vd-cart-change';

export function notifyCart(): void {
  try {
    window.dispatchEvent(new Event(CART_EVENT));
  } catch {
    // No window (tests): nothing listens.
  }
}

/** The number of lines in the cart, or null when this browser has no storage (the cart is off). */
export function storedLineCount(): number | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CART_KEY);
  } catch {
    return null;
  }
  try {
    const lines = (JSON.parse(raw ?? 'null') as { lines?: unknown } | null)?.lines;
    return Array.isArray(lines) ? lines.length : 0;
  } catch {
    return 0;
  }
}

/** Rule CT1: signing out clears the cart, so player IDs do not stay on a shared device. */
export function clearStoredCart(): void {
  try {
    localStorage.removeItem(CART_KEY);
  } catch {
    return;
  }
  notifyCart();
}

/** Calls `onChange` when this tab or another one changes the cart. */
export function subscribeCart(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CART_KEY) onChange();
  };
  window.addEventListener(CART_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CART_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
