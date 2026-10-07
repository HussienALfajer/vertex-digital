/*
 * The address waiting for its verification code, kept in this tab between sign-up (or an
 * unverified sign-in) and /verify-email, so it never appears in a URL. Where the customer goes
 * after verifying travels with it. Session storage can be unavailable: the page then says there is
 * nothing to verify and links back.
 */

const KEY = 'vertex-pending-email';

export interface PendingEmail {
  email: string;
  /** A same-origin path, already checked (`safeRedirect`). */
  next: string;
}

export function savePendingEmail(value: PendingEmail): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Unavailable storage: /verify-email explains how to continue.
  }
}

export function readPendingEmail(): PendingEmail | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<PendingEmail> | null;
    if (typeof value?.email !== 'string') return null;
    return { email: value.email, next: typeof value.next === 'string' ? value.next : '/' };
  } catch {
    return null;
  }
}

export function clearPendingEmail(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
