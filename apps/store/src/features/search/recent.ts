/*
 * The last searches on this device (S09 rule SR5): at most 5, newest first, in `localStorage`
 * only (nothing reaches the server). Storage can be blocked (private mode, rule edge case 20):
 * every access is wrapped, and search works without it.
 */

const KEY = 'vd:recent-searches';
export const RECENT_SEARCHES_MAX = 5;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRecentSearches(): string[] {
  try {
    const value: unknown = JSON.parse(storage()?.getItem(KEY) ?? '[]');
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .slice(0, RECENT_SEARCHES_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Puts `query` first (once), keeping 5; answers the new list. */
export function rememberSearch(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return readRecentSearches();
  const next = [trimmed, ...readRecentSearches().filter((item) => item !== trimmed)].slice(
    0,
    RECENT_SEARCHES_MAX,
  );
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: this search is simply not remembered.
  }
  return next;
}

export function clearRecentSearches(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Blocked storage holds nothing to clear.
  }
}
