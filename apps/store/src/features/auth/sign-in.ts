/** What the sign-in form shows after a failed attempt: one message key per outcome. */
export type SignInFailure = 'INVALID_EMAIL_OR_PASSWORD' | 'RATE_LIMITED' | 'NETWORK' | 'UNKNOWN';

/**
 * Signs a customer in through Better Auth (`/api/auth`, ADR 0007). The session cookie is set by
 * the response; the caller only learns whether it worked and, if not, why.
 */
export async function signIn(
  email: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: SignInFailure }> {
  let response: Response;
  try {
    response = await fetcher('/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
  if (response.ok) return { ok: true };
  if (response.status === 429) return { ok: false, reason: 'RATE_LIMITED' };
  if (response.status === 401) return { ok: false, reason: 'INVALID_EMAIL_OR_PASSWORD' };
  return { ok: false, reason: 'UNKNOWN' };
}
