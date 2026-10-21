import type { Failure } from '@/lib/api';

/**
 * The purchase's refusals decided after the API looked the key up (rules O1–O6, PV8, RS2): no
 * order holds the key, so the same body may go with a new one. `IDEMPOTENCY_KEY_REUSED` too: the
 * key's first request was written and the customer is told to check their orders, so a new slide
 * is a new purchase (F6-14).
 */
const REFUSED_AFTER_LOOKUP: ReadonlySet<Failure> = new Set<Failure>([
  'PRICE_CHANGED',
  'PRODUCT_UNAVAILABLE',
  'INSUFFICIENT_BALANCE',
  'PLAYER_NOT_CONFIRMED',
  'PURCHASES_STOPPED',
  'RESERVATIONS_LIMIT_REACHED',
  'NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'MERCHANT_TERMS_REQUIRED',
]);

/**
 * Whether a refusal frees the key. `VALIDATION_FAILED` may come before the lookup (the body's
 * schema) or after it, so it frees the key only when no earlier answer was lost. Anything else
 * keeps the key, including a rate limit or a lost session: those are answered before the key is
 * looked up, so the first request may still have paid (F6-14).
 */
export function freesKey(reason: Failure, unsettled: boolean): boolean {
  return REFUSED_AFTER_LOOKUP.has(reason) || (reason === 'VALIDATION_FAILED' && !unsettled);
}
