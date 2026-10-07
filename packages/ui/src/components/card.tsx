import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** Flat surface defined by its border, not a shadow (§4). */
function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 text-surface-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="card-header" className={cn('flex flex-col gap-1', className)} {...props} />
  );
}

function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('text-xl font-bold', className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-base text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Card, CardDescription, CardHeader, CardTitle };
