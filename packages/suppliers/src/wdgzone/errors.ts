import { OUT_OF_STOCK_CODE } from '../core/adapter.js';
import { errorReplySchema } from './schemas.js';

/** WDGZone's error code from a refused reply's body (`error.code`). */
export function wdgErrorCode(body: unknown): string | undefined {
  const parsed = errorReplySchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : undefined;
}

/**
 * Purchase refusals that mean nothing was bought, so the next route may be tried (ADR 0004). Seen
 * from the live API on 2026-10-12 (docs/suppliers/wdgzone.md). `OUT_OF_STOCK` comes with 409, which
 * `SupplierHttp` keeps retryable, so the adapter maps it itself. `UNAUTHORIZED` and
 * `ACCOUNT_SUSPENDED` stay retryable: a re-send after a key change must never count an order that
 * was already bought as failed.
 */
export const WDG_DEFINITIVE_PURCHASE_CODES = [
  'PRODUCT_NOT_FOUND',
  'PLAYER_ID_REQUIRED',
  'INSUFFICIENT_BALANCE',
  'INVALID_REQUEST',
  'IDEMPOTENCY_KEY_REQUIRED',
  'INVALID_JSON',
];

export const WDG_OUT_OF_STOCK = OUT_OF_STOCK_CODE;
