import type { ComponentProps, ReactNode } from 'react';
import { AscentLines } from '../brand/ascent-lines';
import { cn } from '../lib/cn';
import { IconTile } from './icon-tile';

interface EmptyStateProps extends Omit<ComponentProps<'div'>, 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

/** Nothing to show yet: a quiet panel with the 60° hairlines beside the message (§5). */
function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'relative flex flex-col items-center gap-3 overflow-hidden rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      <AscentLines className="absolute inset-y-0 end-0 hidden h-full w-16 text-border sm:block" />
      <AscentLines className="absolute inset-y-0 start-0 hidden h-full w-16 text-border sm:block" />
      {icon && (
        <IconTile size="lg" className="relative">
          {icon}
        </IconTile>
      )}
      <p className="relative max-w-sm text-lg font-bold">{title}</p>
      {description && (
        <p className="relative max-w-sm text-base text-muted-foreground">{description}</p>
      )}
      {action && <div className="relative mt-1">{action}</div>}
    </div>
  );
}

export { EmptyState, type EmptyStateProps };
