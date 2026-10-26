import { useEffect } from 'react';
import { safeRedirect } from '@/lib/safe-redirect';
import { readSession } from '@/lib/session';

/**
 * The account entry pages (sign-in, sign-up, the code, recovery) are for signed-out visitors: a
 * signed-in customer goes on to `?next=` or home instead of making a second session (audit A01-13).
 * The header's session read, shared while in flight; a failed read leaves the page as it is.
 */
export function useLeaveIfSignedIn(): void {
  useEffect(() => {
    let active = true;
    void readSession().then((session) => {
      if (!active || !session) return;
      window.location.replace(
        safeRedirect(new URLSearchParams(window.location.search).get('next')),
      );
    });
    return () => {
      active = false;
    };
  }, []);
}
