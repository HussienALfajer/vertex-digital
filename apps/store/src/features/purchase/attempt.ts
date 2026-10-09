/*
 * The `Idempotency-Key` of a purchase attempt (S09 rule BB6), kept in this tab's session storage
 * per pack: a retry of the same body sends the same key, even after the buy box was closed and
 * opened again or the page reloaded, so a lost answer never becomes a second purchase. Cleared on
 * a definitive answer (the order, or a refusal). Without storage the key lives in memory only.
 */

const PREFIX = 'vd:order-attempt:';
const memory = new Map<string, { body: string; key: string }>();

export function attemptKey(productId: string, body: string): string {
  let saved: { body?: unknown; key?: unknown } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(PREFIX + productId) ?? 'null');
  } catch {
    saved = memory.get(productId) ?? null;
  }
  if (saved?.body === body && typeof saved.key === 'string') return saved.key;
  const attempt = { body, key: crypto.randomUUID() };
  memory.set(productId, attempt);
  try {
    sessionStorage.setItem(PREFIX + productId, JSON.stringify(attempt));
  } catch {
    // Unavailable storage: the key in memory still covers retries on this page.
  }
  return attempt.key;
}

export function clearAttempt(productId: string): void {
  memory.delete(productId);
  try {
    sessionStorage.removeItem(PREFIX + productId);
  } catch {
    // Nothing to clear.
  }
}
