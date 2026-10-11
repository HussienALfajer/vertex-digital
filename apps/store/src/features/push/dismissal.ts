/*
 * PC1: a closed permission card stays away for 30 days on this device. Without storage the card
 * shows on every visit and closing it hides it for the visit only.
 */

const KEY = 'vd-push-card-closed';

export function readCardDismissal(): number | null {
  try {
    const value = Number(localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function dismissCard(now = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(now));
  } catch {}
}
