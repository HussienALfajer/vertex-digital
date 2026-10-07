import type { SupplierOutcome } from './adapter.js';

/**
 * A failed supplier call (ADR 0005): `retryable` (timeouts, connection errors, 408, 409, 425,
 * 429, 5xx, an unexpected reply, a refusal the adapter has not mapped) or `definitive` (a refusal
 * whose code the adapter maps as definitive). The supplier's own code is kept for the admin and for
 * each adapter's error mapping.
 */
export class SupplierError extends Error {
  constructor(
    readonly kind: 'retryable' | 'definitive',
    message: string,
    readonly details: { status?: number; supplierCode?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = 'SupplierError';
  }
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
  return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
}
