import { type Challenge, solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';

/** The header the API reads a solved challenge from (ADR 0008). */
export const ALTCHA_HEADER = 'x-altcha';

/**
 * Fetches an ALTCHA challenge and solves its proof of work in the browser, without a widget:
 * sign-up and every code request need one, and the sign-in after repeated failures (rules C5, C8).
 * Returns the `X-Altcha` header, or null when the challenge could not be fetched or solved.
 */
export async function solveAltcha(
  fetcher: typeof fetch = fetch,
): Promise<Record<string, string> | null> {
  try {
    const response = await fetcher('/api/altcha/challenge', { cache: 'no-store' });
    if (!response.ok) return null;
    const challenge = (await response.json()) as Challenge;
    const solution = await solveChallenge({ challenge, deriveKey });
    if (!solution) return null;
    return { [ALTCHA_HEADER]: encodeAltcha(challenge, solution) };
  } catch {
    return null;
  }
}

/** The payload the API expects: the signed challenge and its solution, as base64 JSON. */
export function encodeAltcha(challenge: Challenge, solution: object): string {
  const payload = JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature },
    solution,
  });
  return btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
}
