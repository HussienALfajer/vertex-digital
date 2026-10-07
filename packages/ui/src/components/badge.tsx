'use client';

import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/** Order and money status tones follow brand/identity.md §2; the mapping arrives with F11. */
const badgeVariants = cva(
  'inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium whitespace-nowrap [&>svg]:size-3.5',
  {
    variants: {
      tone: {
        neutral: 'bg-status-neutral text-status-neutral-foreground',
        info: 'bg-status-info text-status-info-foreground',
        gold: 'bg-status-gold text-status-gold-foreground',
        warning: 'bg-status-warning text-status-warning-foreground',
        danger: 'bg-status-danger text-status-danger-foreground',
        success: 'bg-status-success text-status-success-foreground',
        brand: 'bg-status-brand text-status-brand-foreground',
        outline: 'border border-border text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

type BadgeProps = useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

function Badge({ className, tone, render, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: 'span',
    render,
    props: mergeProps<'span'>({ className: cn(badgeVariants({ tone }), className) }, props),
    state: { slot: 'badge', tone },
  });
}

export { Badge, type BadgeProps, badgeVariants };
