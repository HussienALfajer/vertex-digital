import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@vertex-digital/ui';
import type { ComponentProps } from 'react';

/** An icon-only button: its `label` is both its accessible name and its tooltip. */
export function TipButton({
  label,
  children,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={variant} size={size} aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
