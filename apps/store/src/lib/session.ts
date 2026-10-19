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

/** Must match SESSION_HINT_SCRIPT. Holds no personal data: only that a session was seen here. */
const HINT_KEY = 'vd-signed-in';

/**
 * Runs in <head> before the page paints: a browser that was signed in at its last read gets
 * `data-signed-in-hint` on <html>, so the header shows the signed-in placeholder instead of
 * flashing "sign in" while the session is read (pages stay static: the server never knows).
 */
export const SESSION_HINT_SCRIPT = `try{if(localStorage.getItem('${HINT_KEY}'))document.documentElement.setAttribute('data-signed-in-hint','')}catch(e){}`;

function rememberSession(signedIn: boolean) {
  try {
    if (signedIn) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Storage can be unavailable (private mode): the header then waits for the read as before.
  }
}

/** Sign-out: the next page starts signed out at once. */
export const forgetSession = () => rememberSession(false);

let inFlight: Promise<Session> | null = null;

export function readSession(): Promise<Session> {
  if (!inFlight) {
    inFlight = fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        const session = (await response.json()) as Session;
        // Only a clear answer changes the hint; a failed read leaves it as it was.
        rememberSession(session !== null);
        return session;
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Rule CF5: the account is frozen. */
export const isFrozen = (session: Session): boolean => !!session?.user.frozenAt;
