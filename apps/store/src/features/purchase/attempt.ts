import type { Failure, Result } from '@/lib/api';
import { type Attempt, afterAnswer, attemptFor } from '@/lib/idempotency';

/*
 * The `Idempotency-Key` of a purchase attempt (S09 rule BB6), kept in this tab's session storage
 * per pack: a retry of the same body sends the same key, even after the buy box was closed and
 * opened again or the page reloaded, so a lost answer never becomes a second purchase. After an
 * answer that may follow a payment (none, a server fault) the key stays whatever the body, across
 * reloads too, so an edited retry is refused instead of paid twice (F6-14). Cleared on the order,
 * or a refusal that proves no order holds the key. Without storage the key lives in memory only.
 */

const PREFIX = 'vd:order-attempt:';
const memory = new Map<string, Attempt>();

function load(productId: string): Attempt | null {
  let saved: { body?: unknown; key?: unknown; unsettled?: unknown } | null = null;
  try {
    // This page's newest attempt is in memory, even when storage refused to save it; storage
    // answers after a reload or a remount of another page.
    saved =
      memory.get(productId) ?? JSON.parse(sessionStorage.getItem(PREFIX + productId) ?? 'null');
  } catch {
    saved = memory.get(productId) ?? null;
  }
  if (typeof saved?.body !== 'string' || typeof saved.key !== 'string') return null;
  return { body: saved.body, key: saved.key, unsettled: saved.unsettled === true };
}

function save(productId: string, attempt: Attempt | null): void {
  if (!attempt) {
    clearAttempt(productId);
    return;
  }
  memory.set(productId, attempt);
  try {
    sessionStorage.setItem(PREFIX + productId, JSON.stringify(attempt));
  } catch {
    // Unavailable storage: the key in memory still covers retries on this page.
  }
}

/**
 * Sends `body` (serialized) for `productId` through `request`, with the attempt's key. A refusal
 * `frees` the key when it proves no order holds it; it is told whether an earlier answer of this
 * attempt was lost, since a refusal answered before the key is looked up proves nothing then.
 */
export async function sendAttempt<Data>(
  productId: string,
  body: string,
  request: (key: string) => Promise<Result<Data>>,
  frees: (reason: Failure, unsettled: boolean) => boolean,
): Promise<Result<Data>> {
  const attempt = attemptFor(load(productId), body);
  // Unsettled while it is in flight: an edited body sent before this one answers keeps the key,
  // so it is refused or replayed instead of paid beside it (audit A04-1).
  save(productId, { ...attempt, unsettled: true });
  const result = await request(attempt.key);
  save(
    productId,
    !result.ok && frees(result.reason, attempt.unsettled) ? null : afterAnswer(attempt, result),
  );
  return result;
}

export function clearAttempt(productId: string): void {
  memory.delete(productId);
  try {
    sessionStorage.removeItem(PREFIX + productId);
  } catch {
    // Nothing to clear.
  }
}
