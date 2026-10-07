import { type Challenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { api, call } from './api/client';

/** The header the API reads a solved challenge from (ADR 0008). */
export const ALTCHA_HEADER = 'x-altcha';

/**
 * Fetches an ALTCHA challenge and solves its proof of work in the browser, without a widget: the
 * API asks for one after repeated failed sign-ins on an account (`ALTCHA_REQUIRED`). Returns the
 * base64 payload for the `X-Altcha` header.
 */
export async function solveAltcha(): Promise<string> {
  // The API documents this response without a schema: it is altcha-lib's own Challenge.
  const challenge = (await call(api.GET('/api/altcha/challenge'))) as unknown as Challenge;
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error('The ALTCHA challenge could not be solved');
  return encodeAltcha(challenge, solution);
}

/** The payload the API expects: the signed challenge and its solution, as base64 JSON. */
export function encodeAltcha(challenge: Challenge, solution: object): string {
  const payload = JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature },
    solution,
  });
  return btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
}
