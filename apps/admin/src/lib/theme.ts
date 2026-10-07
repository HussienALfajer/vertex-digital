import { useCallback, useState } from 'react';

export type Theme = 'light' | 'dark';

/** Must match the inline script in index.html, which applies the theme before first paint. */
const STORAGE_KEY = 'vertex-admin-theme';

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Light or dark theme: follows the system until the user picks one, then remembers the choice. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(currentTheme);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this page only.
    }
    setThemeState(next);
  }, []);

  const toggle = useCallback(
    () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'),
    [setTheme],
  );

  return { theme, setTheme, toggle };
}
