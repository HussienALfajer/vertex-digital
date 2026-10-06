import { describe, expect, it } from 'vitest';
import { hmacSha256, safeEqual, verifyHmacSignature } from './hmac.js';

describe('hmacSha256', () => {
  it('matches the RFC 4231 test vector', () => {
    // RFC 4231, test case 2.
    expect(hmacSha256('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(hmacSha256('Jefe', 'what do ya want for nothing?', 'base64')).toBe(
      'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=',
    );
  });
});

describe('safeEqual', () => {
  it('compares content and length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('verifyHmacSignature', () => {
  const secret = 'webhook-secret';
  const now = new Date('2026-10-07T12:00:00Z');
  const timestamp = Math.floor(now.getTime() / 1000);
  const signedPayload = `${timestamp}.{"id":"evt_1"}`;
  const signature = hmacSha256(secret, signedPayload);

  it('accepts the right signature within the tolerance', () => {
    expect(verifyHmacSignature({ secret, signedPayload, signature, timestamp, now })).toBe(true);
    expect(
      verifyHmacSignature({ secret, signedPayload, signature, timestamp: timestamp - 299, now }),
    ).toBe(true);
  });

  it('refuses a wrong signature, secret or payload', () => {
    expect(verifyHmacSignature({ secret, signedPayload, signature: 'ab'.repeat(32), now })).toBe(
      false,
    );
    expect(verifyHmacSignature({ secret: 'other', signedPayload, signature, now })).toBe(false);
    expect(
      verifyHmacSignature({ secret, signedPayload: `${signedPayload} `, signature, now }),
    ).toBe(false);
  });

  it('refuses a missing signature or secret', () => {
    expect(verifyHmacSignature({ secret, signedPayload, signature: undefined })).toBe(false);
    expect(verifyHmacSignature({ secret: '', signedPayload, signature })).toBe(false);
  });

  it('refuses a delivery outside the replay window, either way', () => {
    for (const skew of [-301, 301]) {
      expect(
        verifyHmacSignature({ secret, signedPayload, signature, timestamp: timestamp + skew, now }),
      ).toBe(false);
    }
    expect(
      verifyHmacSignature({ secret, signedPayload, signature, timestamp: Number.NaN, now }),
    ).toBe(false);
  });
});
