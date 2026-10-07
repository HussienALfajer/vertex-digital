import type {
  ChangePassword,
  CustomerProfile,
  RequestEmailChange,
  UpdateCustomerProfile,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';
import { withAltcha } from '../auth/requests';

/*
 * The customer's own account (S01 rules C11–C14): the profile under `/api/account`, password,
 * email and sessions under `/api/auth`. Every call carries the session cookie.
 */

type Fetcher = typeof fetch;

/** One signed-in device, as Better Auth lists it (`GET /api/auth/list-sessions`). */
export interface CustomerSession {
  id: string;
  token: string;
  createdAt: string;
  /** Refreshed with use: "last active". */
  updatedAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function getProfile(fetcher: Fetcher = fetch) {
  return apiRequest<CustomerProfile>('/api/account', { fetcher });
}

export function updateProfile(input: UpdateCustomerProfile, fetcher: Fetcher = fetch) {
  return apiRequest<CustomerProfile>('/api/account', { method: 'PATCH', body: input, fetcher });
}

/** The token of this browser's session, to mark "this device" in the list. */
export async function currentSessionToken(fetcher: Fetcher = fetch): Promise<string | null> {
  const result = await apiRequest<{ session?: { token?: string } } | null>(
    '/api/auth/get-session',
    { fetcher },
  );
  return (result.ok && result.data?.session?.token) || null;
}

export function listSessions(fetcher: Fetcher = fetch) {
  return apiRequest<CustomerSession[]>('/api/auth/list-sessions', { fetcher });
}

/** Rule C14: signs out one device. */
export function revokeSession(token: string, fetcher: Fetcher = fetch) {
  return apiRequest('/api/auth/revoke-session', { method: 'POST', body: { token }, fetcher });
}

/** Rule C14: signs out every device, this one included. */
export function revokeAllSessions(fetcher: Fetcher = fetch) {
  return apiRequest('/api/auth/revoke-sessions', { method: 'POST', fetcher });
}

export function signOut(fetcher: Fetcher = fetch) {
  return apiRequest('/api/auth/sign-out', { method: 'POST', fetcher });
}

/** Rule C11: the current password, then every other session is signed out. */
export function changePassword(input: ChangePassword, fetcher: Fetcher = fetch) {
  return apiRequest('/api/auth/change-password', { method: 'POST', body: input, fetcher });
}

/** Rule C12: a code to the new address; the same answer when the address is taken. */
export function requestEmailChange(input: RequestEmailChange, fetcher: Fetcher = fetch) {
  return withAltcha(
    (headers) =>
      apiRequest('/api/auth/email-otp/request-email-change', {
        method: 'POST',
        body: input,
        headers,
        fetcher,
      }),
    fetcher,
  );
}

/** Rule C12: the code from the new address changes the email. */
export function confirmEmailChange(input: { newEmail: string; otp: string }, fetcher = fetch) {
  return apiRequest('/api/auth/email-otp/change-email', { method: 'POST', body: input, fetcher });
}
