import {
  CHECKOUT_LINE_REFUSALS,
  type Checkout,
  type CheckoutLine,
  type CheckoutLineRefusal,
  type CheckoutRequest,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';
import type { CartLine } from './cart';

type Fetcher = typeof fetch;

/**
 * Rule CT5: pays every line in one wallet debit, or none. `key` is the attempt's
 * `Idempotency-Key`: a retry of the same body sends the same key and gets the first checkout
 * back (`200`).
 */
export function payCart(body: CheckoutRequest, key: string, fetcher: Fetcher = fetch) {
  return apiRequest<Checkout>('/api/checkouts', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

/** A cart line as the checkout sends it: the server reads only what a purchase reads. */
export function checkoutLine(line: CartLine): CheckoutLine {
  return {
    productId: line.productId,
    quantity: line.quantity,
    fields: line.fields,
    expectedUnitPriceUsdUnits: line.expectedUnitPriceUsdUnits,
    confirmPlayer: line.confirmPlayer,
    ...(line.savePlayer && { savePlayer: line.savePlayer }),
    ...(line.gift && { gift: line.gift }),
  };
}

const LINE_CODES: ReadonlySet<string> = new Set(CHECKOUT_LINE_REFUSALS);

/**
 * Rule CT6: `CHECKOUT_REFUSED`'s reasons by the line's index in the request. Anything malformed is
 * skipped: the page then shows the general refusal.
 */
export function lineRefusals(details: unknown): Map<number, CheckoutLineRefusal> {
  const refusals = new Map<number, CheckoutLineRefusal>();
  const lines = (details as { lines?: unknown } | null | undefined)?.lines;
  if (!Array.isArray(lines)) return refusals;
  for (const item of lines) {
    const { index, code, details: lineDetails } = (item ?? {}) as Record<string, unknown>;
    if (typeof index !== 'number' || typeof code !== 'string' || !LINE_CODES.has(code)) continue;
    refusals.set(index, {
      index,
      code: code as CheckoutLineRefusal['code'],
      details:
        typeof lineDetails === 'object' && lineDetails !== null
          ? (lineDetails as Record<string, unknown>)
          : {},
    });
  }
  return refusals;
}
