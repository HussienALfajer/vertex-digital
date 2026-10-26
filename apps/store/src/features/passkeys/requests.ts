import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { Passkey } from '@vertex-digital/contracts';
import { apiRequest, type Failure } from '@/lib/api';

/*
 * Customer passkeys (S22 PK2–PK4): the list, the password grant, rename and remove under
 * `/api/account/passkeys`, and the two WebAuthn ceremonies under `/api/auth`. The browser side of a
 * ceremony is `@simplewebauthn/browser`, imported only when a ceremony starts.
 */

type Fetcher = typeof fetch;

/** The browser calls a ceremony needs, typed by the library (A01-17); tests pass fakes. */
export interface Browser {
  startRegistration: (input: {
    optionsJSON: PublicKeyCredentialCreationOptionsJSON;
  }) => Promise<unknown>;
  startAuthentication: (input: {
    optionsJSON: PublicKeyCredentialRequestOptionsJSON;
    useBrowserAutofill?: boolean;
  }) => Promise<unknown>;
}

const loadBrowser = (): Promise<Browser> => import('@simplewebauthn/browser');

/** `CANCELLED`: the customer closed the browser's prompt, or it timed out. */
export type CeremonyFailure = Failure | 'CANCELLED' | 'ALREADY_REGISTERED';

export type CeremonyResult<Data> =
  | { ok: true; data: Data }
  | { ok: false; reason: CeremonyFailure };

/** Whether this browser can make and use passkeys at all (edge case 21). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** Whether the email field can offer the store's passkeys (WebAuthn conditional mediation). */
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const check = window.PublicKeyCredential.isConditionalMediationAvailable;
  return typeof check === 'function'
    ? check.call(window.PublicKeyCredential).catch(() => false)
    : false;
}

/** A browser ceremony's refusal, by the WebAuthn error's name. */
function ceremonyFailure(error: unknown): CeremonyFailure {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'CANCELLED';
  if (name === 'InvalidStateError') return 'ALREADY_REGISTERED';
  return 'UNKNOWN';
}

export function listPasskeys(fetcher: Fetcher = fetch) {
  return apiRequest<Passkey[]>('/api/account/passkeys', { fetcher });
}

/** PK2: the password opens this session's registration for 5 minutes. */
export function authorizePasskey(password: string, fetcher: Fetcher = fetch) {
  return apiRequest('/api/account/passkeys/authorize', {
    method: 'POST',
    body: { password },
    fetcher,
  });
}

export function renamePasskey(id: string, name: string, fetcher: Fetcher = fetch) {
  return apiRequest<Passkey>(`/api/account/passkeys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
    fetcher,
  });
}

export function removePasskey(id: string, fetcher: Fetcher = fetch) {
  return apiRequest(`/api/account/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fetcher,
  });
}

/** PK2: the options, the browser's prompt, then the verification, which writes the passkey. */
export async function registerPasskey(
  fetcher: Fetcher = fetch,
  browser: () => Promise<Browser> = loadBrowser,
): Promise<CeremonyResult<{ id: string; name: string }>> {
  const options = await apiRequest<PublicKeyCredentialCreationOptionsJSON>(
    '/api/auth/passkey/register-options',
    { method: 'POST', body: {}, fetcher },
  );
  if (!options.ok) return options;
  let response: unknown;
  try {
    response = await (await browser()).startRegistration({ optionsJSON: options.data });
  } catch (error) {
    return { ok: false, reason: ceremonyFailure(error) };
  }
  return apiRequest<{ id: string; name: string }>('/api/auth/passkey/register', {
    method: 'POST',
    body: { response },
    fetcher,
  });
}

/**
 * PK3: the options, the browser's prompt (or, with `autofill`, the email field's suggestions,
 * which wait until the customer picks one), then the sign-in, which sets the session cookie.
 */
export async function signInWithPasskey(
  { autofill = false }: { autofill?: boolean } = {},
  fetcher: Fetcher = fetch,
  browser: () => Promise<Browser> = loadBrowser,
): Promise<CeremonyResult<unknown>> {
  const options = await apiRequest<PublicKeyCredentialRequestOptionsJSON>(
    '/api/auth/passkey/sign-in-options',
    { method: 'POST', body: {}, fetcher },
  );
  if (!options.ok) return options;
  let response: unknown;
  try {
    response = await (await browser()).startAuthentication({
      optionsJSON: options.data,
      useBrowserAutofill: autofill,
    });
  } catch (error) {
    return { ok: false, reason: ceremonyFailure(error) };
  }
  return apiRequest('/api/auth/sign-in/passkey', { method: 'POST', body: { response }, fetcher });
}
