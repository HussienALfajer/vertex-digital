import type { FailureKind } from '@vertex-digital/contracts';
import type { SupplierOutcome } from './adapter.js';

/**
 * A failed supplier call (ADR 0005): `retryable` (timeouts, connection errors, 408, 409, 425,
 * 429, 5xx, an unexpected reply, a refusal the adapter has not mapped) or `definitive` (a refusal
 * whose code the adapter maps as definitive). The supplier's own code is kept for the admin and for
 * each adapter's error mapping; S18 FK1: `failure` says why there was no trustworthy answer, and
 * `retryAt` when a rate limit lifts (from the reply's headers).
 */
export interface SupplierErrorDetails {
  status?: number;
  supplierCode?: string;
  failure?: FailureKind;
  retryAt?: number;
  cause?: unknown;
}

export class SupplierError extends Error {
  constructor(
    readonly kind: 'retryable' | 'definitive',
    message: string,
    readonly details: SupplierErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.name = 'SupplierError';
  }
}

/** A method behind a capability the adapter does not declare: a definitive refusal. */
export function notSupported(supplier: string, what: string): Promise<never> {
  return Promise.reject(new SupplierError('definitive', `${supplier} does not ${what}`));
}

/**
 * The outcome of an order call that threw. Only a definitive refusal means nothing was bought;
 * anything else (a timeout, a lost connection, a reply that could not be read) may have bought
 * the goods, so it is `unknown`, never `failed_definitive` (ADR 0004).
 */
export function outcomeOfOrderError(error: unknown): SupplierOutcome {
  if (error instanceof SupplierError && error.kind === 'definitive') {
    return {
      status: 'failed_definitive',
      reason: error.message,
      ...(error.details.supplierCode !== undefined && { supplierCode: error.details.supplierCode }),
    };
  }
  const details = error instanceof SupplierError ? error.details : {};
  return {
    status: 'unknown',
    reason: error instanceof Error ? error.message : String(error),
    failure: details.failure ?? 'other',
    ...(details.status !== undefined && { httpStatus: details.status }),
    ...(details.supplierCode !== undefined && { supplierCode: details.supplierCode }),
  };
}
