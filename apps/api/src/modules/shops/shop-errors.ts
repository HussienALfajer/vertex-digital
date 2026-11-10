import type { ErrorCode } from '@vertex-digital/contracts';
import { LedgerError, OrderError, ShopError } from '@vertex-digital/db';
import { CodedException } from '../../core/errors/index.js';

/** The HTTP status of each coded refusal of the shop write paths (S26 "API"). */
const STATUS: Partial<Record<ErrorCode, 400 | 403 | 404 | 409>> = {
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  NOT_MERCHANT: 403,
  ACCOUNT_FROZEN: 403,
  SHOP_UNAVAILABLE: 403,
};

/** A `ShopError`, `OrderError` or `LedgerError` as the API answers it; anything else as is. */
export function shopErrorToHttp(error: unknown): unknown {
  if (error instanceof ShopError || error instanceof OrderError || error instanceof LedgerError) {
    return new CodedException(
      STATUS[error.code] ?? 409,
      error.code,
      error.message,
      error.details ?? undefined,
    );
  }
  return error;
}
