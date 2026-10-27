import type { Failure } from '@/lib/api';

/**
 * The checkout's refusals decided after the API looked the key up (rule CT5): no checkout holds
 * the key, so the changed cart may go with a new one. `IDEMPOTENCY_KEY_REUSED` too: the key's
 * first checkout was written and the customer is told to check their orders (F6-14).
 */
const REFUSED_AFTER_LOOKUP: ReadonlySet<Failure> = new Set<Failure>([
  'CHECKOUT_REFUSED',
  'INSUFFICIENT_BALANCE',
  'PURCHASES_STOPPED',
  'IDEMPOTENCY_KEY_REUSED',
  'MERCHANT_TERMS_REQUIRED',
]);

/** Refusals answered before the key is looked up (the body's schema, the access guard). */
const REFUSED_BEFORE_LOOKUP: ReadonlySet<Failure> = new Set<Failure>([
  'VALIDATION_FAILED',
  'EMAIL_NOT_VERIFIED',
]);

/**
 * Whether a checkout's refusal frees its key: one decided after the lookup, or one answered
 * before it while no earlier answer was lost. Anything else keeps the key: the first request may
 * have paid. Shared by the cart and the merchant's bulk payment (audit A06-5).
 */
export function freesCheckoutKey(reason: Failure, unsettled: boolean): boolean {
  return REFUSED_AFTER_LOOKUP.has(reason) || (REFUSED_BEFORE_LOOKUP.has(reason) && !unsettled);
}
