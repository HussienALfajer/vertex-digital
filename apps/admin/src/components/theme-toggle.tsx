import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui';
import { MoonIcon, SunIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../lib/theme';

/** Switches between the light and dark themes. */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? t('theme.toLight') : t('theme.toDark');
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={className}
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
