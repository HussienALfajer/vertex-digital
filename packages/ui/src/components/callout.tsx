import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

const calloutVariants = cva(
  'flex flex-col gap-3 rounded-lg px-4 py-3 sm:flex-row sm:items-center [&_[data-slot=callout-icon]_svg]:size-5',
  {
    variants: {
      tone: {
        neutral: 'bg-status-neutral text-status-neutral-foreground',
        info: 'bg-status-info text-status-info-foreground',
        warning: 'bg-status-warning text-status-warning-foreground',
        danger: 'bg-status-danger text-status-danger-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

interface CalloutProps
  extends Omit<ComponentProps<'div'>, 'title'>,
    VariantProps<typeof calloutVariants> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** A button that resolves the situation, placed at the inline end. */
  action?: ReactNode;
}

/** A standing notice about the record on screen (archived, missing data), with an optional fix. */
function Callout({ tone, icon, title, description, action, className, ...props }: CalloutProps) {
  return (
    <div data-slot="callout" className={cn(calloutVariants({ tone }), className)} {...props}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {icon && (
          <span data-slot="callout-icon" aria-hidden="true" className="mt-0.5 flex shrink-0">
            {icon}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-base font-medium">{title}</p>
          {description && <p className="text-sm">{description}</p>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export { Callout, type CalloutProps };
