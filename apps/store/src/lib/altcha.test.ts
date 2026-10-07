import { createChallenge, solveChallenge, verifySolution } from 'altcha-lib';
import { deriveKey as nodeDeriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { deriveKey as webDeriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { describe, expect, it } from 'vitest';
import { encodeAltcha } from './altcha';

const secret = 'test-only-hmac-key';

describe('ALTCHA in the browser', () => {
  it('solves a challenge that the API verifies, and encodes it as the API reads it', async () => {
    // As apps/api/src/core/altcha/altcha.service.ts signs and verifies, with a small counter.
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: 10,
      counter: 5,
      deriveKey: nodeDeriveKey,
      hmacSignatureSecret: secret,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const solution = await solveChallenge({ challenge, deriveKey: webDeriveKey });
    if (!solution) throw new Error('not solved');

    const payload = JSON.parse(atob(encodeAltcha(challenge, solution)));
    expect(payload.challenge).toEqual({
      parameters: challenge.parameters,
      signature: challenge.signature,
    });
    const result = await verifySolution({
      challenge: payload.challenge,
      solution: payload.solution,
      deriveKey: nodeDeriveKey,
      hmacSignatureSecret: secret,
    });
    expect(result.verified).toBe(true);
  });
});
