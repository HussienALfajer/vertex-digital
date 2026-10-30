'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { MoonIcon, SunIcon } from 'lucide-react';
import { t } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

/** Switches between the dark (default) and light themes. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? t('theme.toLight') : t('theme.toDark');
  return (
    // `title`, not the design system's tooltip: that brought Base UI's tooltip and Floating UI, some
    // 30 KB, into the first load of every page.
    <Button
      variant="ghost"
      size="icon"
      className="size-11"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
