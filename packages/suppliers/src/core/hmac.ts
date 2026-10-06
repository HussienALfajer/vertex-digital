import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Webhook signatures (ADR 0005, 0008): HMAC-SHA256 over the exact bytes the supplier signed,
 * compared in constant time, with a timestamp tolerance against replays of old deliveries.
 * Each adapter builds the signed string the way its supplier documents it.
 */

export type SignatureEncoding = 'hex' | 'base64';

export function hmacSha256(
  secret: string,
  payload: string,
  encoding: SignatureEncoding = 'hex',
): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest(encoding);
}

/** Compares two strings in time that depends only on their length, never on their content. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still spend a comparison, so a length mismatch answers no faster than a content one.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Default replay window: a delivery older or newer than this is refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface VerifySignatureInput {
  secret: string;
  /** Exactly what the supplier signed (often `${timestamp}.${rawBody}`). */
  signedPayload: string;
  /** The signature from the request header, without any `sha256=` prefix. */
  signature: string | undefined;
  encoding?: SignatureEncoding;
  /** Unix seconds from the request, when the supplier sends one. */
  timestamp?: number | undefined;
  toleranceSeconds?: number;
  now?: Date;
}

export function verifyHmacSignature(input: VerifySignatureInput): boolean {
  if (!input.signature || !input.secret) return false;
  if (input.timestamp !== undefined) {
    const skew = Math.abs((input.now ?? new Date()).getTime() / 1000 - input.timestamp);
    if (!Number.isFinite(skew) || skew > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
      return false;
    }
  }
  const expected = hmacSha256(input.secret, input.signedPayload, input.encoding);
  return safeEqual(expected, input.signature);
}
