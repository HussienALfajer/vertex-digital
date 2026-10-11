/*
 * The announcement's dismissal on this device (S14 AN4): `<id>:<revision>` in `localStorage`, so an
 * edited text, link or tone shows again. Read and written behind try/catch: without storage the bar
 * closes for the page view only.
 */

export const DISMISSED_KEY = 'vd-announcement-dismissed';

/** What the bar compares with the stored value. */
export const announcementKey = (id: string, revision: number) => `${id}:${revision}`;

export function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Remembers the closed bar; false when storage is unavailable (private mode, blocked). */
export function writeDismissed(key: string): boolean {
  try {
    localStorage.setItem(DISMISSED_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs right after the bar's markup, before it paints (a constant string, ADR 0015): hides a bar
 * this device closed, so it never flashes on load. The bar's own client part keeps it hidden.
 */
export const DISMISSED_SCRIPT = `try{var b=document.currentScript.previousElementSibling;if(b&&localStorage.getItem('${DISMISSED_KEY}')===b.getAttribute('data-announcement'))b.hidden=true}catch(e){}`;
