/*
 * The customer's session as Better Auth answers `GET /api/auth/get-session`, read in the browser
 * so every page stays static. The header, the frozen banner and the buy box mount together on a
 * page: they share one request while it is in flight, and a later mount reads it again (a
 * sign-in, a freeze or a sign-out since).
 */

export type SessionUser = {
  name: string;
  email: string;
  emailVerified?: boolean;
  /** S12 CF5: set while the admin has frozen the account; the reason is never sent. */
  frozenAt?: string | null;
};

export type Session = { user: SessionUser; session?: { token?: string } } | null;

let inFlight: Promise<Session> | null = null;

export function readSession(): Promise<Session> {
  if (!inFlight) {
    inFlight = fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<Session>) : null))
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Rule CF5: the account is frozen. */
export const isFrozen = (session: Session): boolean => !!session?.user.frozenAt;
