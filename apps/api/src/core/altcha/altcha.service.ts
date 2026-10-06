import { Inject, Injectable } from '@nestjs/common';
import { type Challenge, createChallenge, randomInt, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { CodedException } from '../errors/index.js';

/** How long a challenge can be solved and submitted. */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** PBKDF2 iterations per attempt; the work is this times the counter. */
const COST = 500;

const payloadSchema = z.object({
  challenge: z.object({
    parameters: z.looseObject({
      algorithm: z.string(),
      nonce: z.string(),
      salt: z.string(),
      cost: z.number(),
      keyLength: z.number(),
      keyPrefix: z.string(),
      // Every challenge this API signs expires; one without could be replayed forever.
      expiresAt: z.number(),
    }),
    signature: z.string().min(1),
  }),
  solution: z.object({ counter: z.number().int().nonnegative(), derivedKey: z.string() }),
});

/**
 * Self-hosted ALTCHA proof of work (ADR 0008): challenges signed with `ALTCHA_HMAC_KEY`, each
 * solution accepted once until its challenge expires. Used solutions are kept in memory: the API
 * runs as one process (ADR 0009).
 */
@Injectable()
export class AltchaService {
  private readonly used = new Map<string, number>();
  private readonly keySecret: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.keySecret = `${env.ALTCHA_HMAC_KEY}:key`;
  }

  createChallenge(now = Date.now()): Promise<Challenge> {
    const max = this.env.ALTCHA_MAX_COUNTER;
    return createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost: COST,
      counter: randomInt(Math.floor(max / 2), max),
      deriveKey,
      hmacSignatureSecret: this.env.ALTCHA_HMAC_KEY,
      hmacKeySignatureSecret: this.keySecret,
      expiresAt: new Date(now + CHALLENGE_TTL_MS),
    });
  }

  /**
   * Accepts a solved challenge once, from the base64 JSON payload the widget sends; throws
   * `ALTCHA_REQUIRED` without one and `ALTCHA_INVALID` for a wrong, expired or reused one.
   */
  async verify(header: string | undefined, now = Date.now()): Promise<void> {
    if (!header) throw new CodedException(400, 'ALTCHA_REQUIRED', 'Solve the challenge first');
    const invalid = () => new CodedException(400, 'ALTCHA_INVALID', 'The challenge failed');
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      throw invalid();
    }
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) throw invalid();
    const { challenge, solution } = parsed.data;
    const result = await verifySolution({
      challenge,
      solution,
      deriveKey,
      hmacSignatureSecret: this.env.ALTCHA_HMAC_KEY,
      hmacKeySignatureSecret: this.keySecret,
    });
    if (!result.verified) throw invalid();

    for (const [signature, expiresAt] of this.used) {
      if (expiresAt * 1000 < now) this.used.delete(signature);
    }
    if (this.used.has(challenge.signature)) throw invalid();
    this.used.set(challenge.signature, challenge.parameters.expiresAt);
  }
}
