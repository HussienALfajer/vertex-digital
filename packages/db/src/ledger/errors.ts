import type { ErrorCode } from '@vertex-digital/contracts';

/**
 * A ledger refusal the caller can act on, with its contract code (ADR 0011): the API turns it
 * into its coded HTTP error. Malformed journals throw a plain `Error`: they are bugs.
 */
export class LedgerError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}
