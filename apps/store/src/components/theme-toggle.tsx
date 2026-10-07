'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui/components/tooltip';
import { MoonIcon, SunIcon } from 'lucide-react';
import { t } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

/** Switches between the dark (default) and light themes. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? t('theme.toLight') : t('theme.toDark');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={toggle}
            aria-label={label}
          />
        }
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
