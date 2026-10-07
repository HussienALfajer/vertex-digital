import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** A placeholder block with the shape of content that is loading. */
function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
