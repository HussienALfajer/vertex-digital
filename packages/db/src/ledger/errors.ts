import type { ErrorCode } from '@vertex-digital/contracts';

/**
 * A ledger refusal the caller can act on, with its contract code (ADR 0011): the API turns it
 * into its coded HTTP error. Malformed journals throw a plain `Error`: they are bugs.
 */
export class LedgerError extends Error {
  readonly code: ErrorCode;
  /** Machine-readable extras for the API's error `details`. */
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}
