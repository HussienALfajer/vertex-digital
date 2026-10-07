'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

/** Must match THEME_SCRIPT, which applies the saved theme before first paint. */
const STORAGE_KEY = 'vertex-theme';

/**
 * Runs in <head> before the page paints: the store is dark unless the customer chose light
 * (brand/identity.md §6), so a saved choice never flashes the other theme.
 */
export const THEME_SCRIPT = `try{if(localStorage.getItem('${STORAGE_KEY}')==='light')document.documentElement.classList.remove('dark')}catch(e){}`;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const current = (): Theme =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

/** Dark by default; the customer's choice is remembered in this browser. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as const);

  const toggle = useCallback(() => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
    for (const listener of listeners) listener();
  }, []);

  return { theme, toggle };
}
