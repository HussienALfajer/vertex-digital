import { useEffect } from 'react';

/*
 * What a customer typed in a long form, kept in this tab's session storage so that a same-tab link,
 * a re-show of the page or a reload does not lose it. Never in the URL, never a password or a file.
 * Cleared on success and when the session ends (`forgetThisBrowser`). Storage can be unavailable:
 * the form then simply starts empty.
 */

const PREFIX = 'vd:form-draft:';

export function readFormDraft<Draft>(name: string): Draft | null {
  try {
    return JSON.parse(sessionStorage.getItem(PREFIX + name) ?? 'null') as Draft | null;
  } catch {
    return null;
  }
}

export function saveFormDraft(name: string, draft: unknown): void {
  try {
    sessionStorage.setItem(PREFIX + name, JSON.stringify(draft));
  } catch {
    // Without storage the draft lives only in the form.
  }
}

export function clearFormDraft(name: string): void {
  try {
    sessionStorage.removeItem(PREFIX + name);
  } catch {
    // Nothing to clear.
  }
}

/** Every form draft of this tab: the session ended. */
export function forgetFormDrafts(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing to clear.
  }
}

/** Asks the browser to warn before leaving the page while `dirty` (a reload, a closed tab). */
export function useLeaveWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
