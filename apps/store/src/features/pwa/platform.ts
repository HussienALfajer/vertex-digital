/*
 * Which Apple browser this is, for the iOS install steps (S15 IN1, PC3). Kept apart from the push
 * rules: the footer's install button needs only this on every page.
 */

/** iPhone, iPod, or an iPad (which reports itself as a Mac with touch). */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Safari itself, not Chrome, Firefox or Edge on iOS (each adds its own token). */
export function isSafari(userAgent: string): boolean {
  return /Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
}
