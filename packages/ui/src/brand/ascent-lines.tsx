'use client';

import { type ComponentProps, useId } from 'react';
import { cn } from '../lib/cn';

/**
 * Parallel hairlines at the logo's 60° angle (§5): a quiet pattern for the login screen and empty
 * states, drawn in the current text color. Keep it beside content, never behind it, and static.
 */
function AscentLines({ className, ...props }: Omit<ComponentProps<'svg'>, 'children'>) {
  const id = useId();
  return (
    <svg aria-hidden="true" className={cn('pointer-events-none', className)} {...props}>
      <defs>
        {/* Vertical lines rotated 30° clockwise lean like the mark's rising strokes: 60° to the baseline. */}
        <pattern
          id={id}
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(30)"
        >
          <line x1="0" y1="0" x2="0" y2="20" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

export { AscentLines };
