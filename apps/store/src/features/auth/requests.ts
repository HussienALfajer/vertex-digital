import type { CustomerSignUp, Registration } from '@vertex-digital/contracts';
import { solveAltcha } from '@/lib/altcha';
import { apiRequest, type Result } from '@/lib/api';

/*
 * Customer account requests (S01, ADR 0007): Better Auth and the auth module under `/api/auth`.
 * Session cookies are set by the responses; the screens only learn whether a call worked and,
 * if not, its code.
 */

type Fetcher = typeof fetch;

/** Runs a request that needs a solved ALTCHA challenge (rule C5); refused when none is solved. */
export async function withAltcha<Data>(
  send: (headers: Record<string, string>) => Promise<Result<Data>>,
  fetcher: Fetcher = fetch,
): Promise<Result<Data>> {
  const headers = await solveAltcha(fetcher);
  if (!headers) return { ok: false, reason: 'ALTCHA_INVALID' };
  return send(headers);
}

/**
 * Whether sign-up is open (rule C16): `failed` when it could not be read, so a network error or a
 * rate limit is never shown as "registration closed".
 */
export async function registrationState(
  fetcher: Fetcher = fetch,
): Promise<'open' | 'closed' | 'failed'> {
  const result = await apiRequest<Registration>('/api/auth/registration', { fetcher });
  if (!result.ok) return 'failed';
  return result.data.open ? 'open' : 'closed';
}

/**
 * Signs in. After 3 failures for the email the API asks for proof of work (rule C8): it is solved
 * and the same sign-in sent again, once. `onVerifying` tells the form while that runs.
 */
export async function signIn(
  email: string,
  password: string,
  { fetcher = fetch, onVerifying }: { fetcher?: Fetcher; onVerifying?: () => void } = {},
): Promise<Result<unknown>> {
  const send = (headers?: Record<string, string>) =>
    apiRequest('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email, password },
      headers,
      fetcher,
    });
  const result = await send();
  if (result.ok || (result.reason !== 'ALTCHA_REQUIRED' && result.reason !== 'ALTCHA_INVALID')) {
    return result;
  }
  onVerifying?.();
  return withAltcha(send, fetcher);
}

/** Rule C1: creates an unverified account and emails a code; the same answer for a known email. */
export function signUp(input: CustomerSignUp, fetcher: Fetcher = fetch): Promise<Result<unknown>> {
  return withAltcha(
    (headers) =>
      apiRequest('/api/auth/sign-up/email', { method: 'POST', body: input, headers, fetcher }),
    fetcher,
  );
}

/** A new verification code (rules C4, C5): the previous one stops working. */
export function sendVerificationCode(email: string, fetcher: Fetcher = fetch) {
  return withAltcha(
    (headers) =>
      apiRequest('/api/auth/email-otp/send-verification-otp', {
        method: 'POST',
        body: { email },
        headers,
        fetcher,
      }),
    fetcher,
  );
}

/** Rule C7: the right code verifies the email and signs the customer in. */
export function verifyEmail(email: string, otp: string, fetcher: Fetcher = fetch) {
  return apiRequest('/api/auth/email-otp/verify-email', {
    method: 'POST',
    body: { email, otp },
    fetcher,
  });
}

/** Emails a password-reset code; the same answer whether or not the email has an account. */
export function requestPasswordReset(email: string, fetcher: Fetcher = fetch) {
  return withAltcha(
    (headers) =>
      apiRequest('/api/auth/email-otp/request-password-reset', {
        method: 'POST',
        body: { email },
        headers,
        fetcher,
      }),
    fetcher,
  );
}

/** Rule C7: sets the new password and signs out every session. */
export function resetPassword(
  input: { email: string; otp: string; password: string },
  fetcher: Fetcher = fetch,
) {
  return apiRequest('/api/auth/email-otp/reset-password', {
    method: 'POST',
    body: input,
    fetcher,
  });
}
