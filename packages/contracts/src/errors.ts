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
  /** A malformed request the validation did not describe (bad JSON, wrong content type). */
  'BAD_REQUEST',
  /** The input failed its contract schema; the issues are in `details`. */
  'VALIDATION_FAILED',
  /** No valid session for this route. */
  'UNAUTHORIZED',
  /** Signed in, but with the wrong kind of session or no right to this record. */
  'FORBIDDEN',
  /** The admin has not enrolled TOTP yet (ADR 0007, 0016). */
  'TWO_FACTOR_REQUIRED',
  /** A customer whose email is not verified yet (ADR 0007). */
  'EMAIL_NOT_VERIFIED',
  /** A route that needs a solved ALTCHA challenge got none (ADR 0008). */
  'ALTCHA_REQUIRED',
  /** The ALTCHA solution is wrong, expired or already used (ADR 0008). */
  'ALTCHA_INVALID',
  /** A browser request from an origin other than the host's own (ADR 0007, 0008). */
  'CROSS_ORIGIN_REFUSED',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  /** Too many requests from this client; retry later (ADR 0008). */
  'RATE_LIMITED',
  /** An unexpected server error; the details are only in the logs and Sentry. */
  'INTERNAL_ERROR',
  /** Customer sign-up while registration is closed (S01 rule C16). */
  'REGISTRATION_CLOSED',
  /** A sensitive admin action without a re-authentication in the last 5 minutes (rule D5). */
  'REAUTHENTICATION_REQUIRED',
  /** The admin signed in with a CLI-issued password and must change it first (rule D1). */
  'PASSWORD_CHANGE_REQUIRED',
  /** The email belongs to another account (admin routes and races only: rules T3, C12). */
  'EMAIL_TAKEN',
  /** The new password is in the common-password list (rules C3, D6). */
  'PASSWORD_TOO_COMMON',
  /** The admin session ended after 30 minutes without activity (rule D4). */
  'SESSION_IDLE_EXPIRED',
  /** A wrong current password on a change or a re-authentication (rules C11, C12, D5, D7). */
  'INVALID_PASSWORD',
  /** A wrong authenticator code on a re-authentication (rule D5). */
  'INVALID_CODE',
  /** A wrong or unknown email code (rule C4). */
  'INVALID_OTP',
  /** The email code expired: request a new one (rule C4). */
  'OTP_EXPIRED',
  /** Five wrong tries voided the email code: request a new one (rule C4). */
  'TOO_MANY_ATTEMPTS',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The body of every error the API answers (ADR 0011). */
export const errorResponseSchema = z
  .object({
    statusCode: z.int().min(400).max(599),
    code: errorCodeSchema,
    /** English, for logs; the UI shows the translation of `code`. */
    message: z.string(),
    /** Machine-readable extras, such as the validation issues. */
    details: z.unknown().optional(),
  })
  .meta({ id: 'ErrorResponse' });

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
