/*
 * Access changes found by any request, API or Better Auth, handled in one place (`main.tsx`, which
 * owns the router): the session ended after 30 minutes without activity (rule D4), or the
 * CLI-issued password must be changed first (rule D1).
 */

export type AccessEvent = 'idle-expired' | 'password-change-required';

const target = new EventTarget();

export function reportAccess(event: AccessEvent): void {
  target.dispatchEvent(new Event(event));
}

export function onAccess(event: AccessEvent, listener: () => void): () => void {
  target.addEventListener(event, listener);
  return () => target.removeEventListener(event, listener);
}

/** The access event an error code reports, if any. */
export function accessEventOf(code: string | undefined): AccessEvent | undefined {
  if (code === 'SESSION_IDLE_EXPIRED') return 'idle-expired';
  if (code === 'PASSWORD_CHANGE_REQUIRED') return 'password-change-required';
  return undefined;
}
