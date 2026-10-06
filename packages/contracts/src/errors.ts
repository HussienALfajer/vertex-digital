import { z } from 'zod';

/**
 * Codes on errors the UI must tell apart (ADR 0011). The front ends show the translation of the
 * code, never the server message. A code is added with its first use.
 */
export const ERROR_CODES = [
  /** A debit would take a customer wallet below zero (ADR 0003). */
  'INSUFFICIENT_BALANCE',
  /** An idempotency key was used again for a different request or journal (ADR 0003, 0004). */
  'IDEMPOTENCY_KEY_REUSED',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });

export type ErrorCode = z.infer<typeof errorCodeSchema>;
