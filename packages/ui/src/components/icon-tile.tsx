import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

const iconTileVariants = cva('flex shrink-0 items-center justify-center rounded-lg', {
  variants: {
    tone: {
      muted: 'bg-muted text-muted-foreground',
      success: 'bg-status-success text-status-success-foreground',
      warning: 'bg-status-warning text-status-warning-foreground',
    },
    size: {
      md: 'size-11 [&_svg]:size-5',
      lg: 'size-12 [&_svg]:size-6',
    },
  },
  defaultVariants: { tone: 'muted', size: 'md' },
});

type IconTileProps = ComponentProps<'span'> & VariantProps<typeof iconTileVariants>;

/** An icon on a tinted square that heads a dialog, a card or an outcome; decorative. */
function IconTile({ className, tone, size, ...props }: IconTileProps) {
  return (
    <span
      data-slot="icon-tile"
      aria-hidden="true"
      className={cn(iconTileVariants({ tone, size }), className)}
      {...props}
    />
  );
}

export { IconTile, type IconTileProps };
