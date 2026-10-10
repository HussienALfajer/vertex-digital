import type { ErrorCode } from '@vertex-digital/contracts';

/** A purchase refusal the API answers with its contract code (S08 rules O1–O5). */
export class OrderError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.details = details;
  }
}
