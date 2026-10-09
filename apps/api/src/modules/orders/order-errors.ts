import type { ErrorCode } from '@vertex-digital/contracts';
import { LedgerError, OrderError } from '@vertex-digital/db';
import { CodedException } from '../../core/errors/index.js';

/** The HTTP status of each coded refusal of the order write path (S08 "API"). */
const STATUS: Partial<Record<ErrorCode, 400 | 404 | 409>> = {
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CODES_COUNT_MISMATCH: 400,
  PURCHASES_STOPPED: 409,
  PRODUCT_UNAVAILABLE: 409,
  PRICE_CHANGED: 409,
  INSUFFICIENT_BALANCE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  ORDER_NOT_DECIDABLE: 409,
  ATTEMPT_NOT_RESOLVABLE: 409,
  PLAYER_NOT_CONFIRMED: 409,
  RESERVATIONS_LIMIT_REACHED: 409,
  ORDER_NOT_CANCELLABLE: 409,
  CHECKOUT_REFUSED: 409,
  ORDER_NOT_SHAREABLE: 409,
};

/** An `OrderError` or `LedgerError` as the API answers it; anything else is rethrown as is. */
export function asCodedException(error: unknown): unknown {
  if (error instanceof OrderError || error instanceof LedgerError) {
    return new CodedException(
      STATUS[error.code] ?? 409,
      error.code,
      error.message,
      error.details ?? undefined,
    );
  }
  return error;
}

export const orderRefusals = {
  notFound: () => new CodedException(404, 'NOT_FOUND', 'No such order'),
  rateLimited: () => new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later'),
  notDecidable: () =>
    new CodedException(409, 'ORDER_NOT_DECIDABLE', 'The order is not waiting for a decision'),
  notResolvable: () =>
    new CodedException(409, 'ATTEMPT_NOT_RESOLVABLE', 'The attempt cannot take this decision'),
  keyReused: () =>
    new CodedException(409, 'IDEMPOTENCY_KEY_REUSED', 'The key was used for another decision'),
  tooManyUnits: (max: number) =>
    new CodedException(400, 'VALIDATION_FAILED', `At most ${max} units were asked`, [
      { path: ['quantity'], message: `Expected at most ${max}` },
    ]),
  notShareable: (reason: 'status' | 'not_gift' | 'link_exists') =>
    new CodedException(409, 'ORDER_NOT_SHAREABLE', 'The order cannot have this link', { reason }),
  codesCount: () =>
    new CodedException(400, 'CODES_COUNT_MISMATCH', 'Expected one code per unit delivered'),
};
