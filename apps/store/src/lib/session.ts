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
  /** S21 MA1: `merchant` opens "أدوات التاجر". */
  accountType?: 'customer' | 'merchant';
};

export type Session = { user: SessionUser; session?: { token?: string } } | null;

/** Must match SESSION_HINT_SCRIPT. Holds no personal data: only that a session was seen here. */
const HINT_KEY = 'vd-signed-in';

/**
 * S20 AT4: this browser's account paid other than retail at its last read (`1` only, never the
 * kind or a price). SESSION_HINT_SCRIPT turns it into `data-private-prices-hint`, which hides the
 * cached retail prices of a game page before paint (`features/catalog/private-prices.ts`).
 */
export const PRIVATE_PRICES_HINT_KEY = 'vd-private-prices';

/**
 * Runs in <head> before the page paints: a browser that was signed in at its last read gets
 * `data-signed-in-hint` on <html>, so the header shows the signed-in placeholder instead of
 * flashing "sign in" while the session is read (pages stay static: the server never knows).
 */
export const SESSION_HINT_SCRIPT = `try{if(localStorage.getItem('${HINT_KEY}'))document.documentElement.setAttribute('data-signed-in-hint','');if(localStorage.getItem('${PRIVATE_PRICES_HINT_KEY}'))document.documentElement.setAttribute('data-private-prices-hint','')}catch(e){}`;

function rememberSession(signedIn: boolean) {
  try {
    if (signedIn) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Storage can be unavailable (private mode): the header then waits for the read as before.
  }
}

/** Sign-out: the next page starts signed out at once, with retail prices. */
export const forgetSession = () => {
  rememberSession(false);
  try {
    localStorage.removeItem(PRIVATE_PRICES_HINT_KEY);
  } catch {
    // Storage can be unavailable (private mode): there is no hint to forget then.
  }
};

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
