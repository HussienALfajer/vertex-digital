import { ArrowRightIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';

/**
 * A link to the page above this one, always a fixed path: a visitor who arrived from another site
 * must never be sent back to it. `render` is the app's link; the arrow points the reading way back.
 */
function BackLink({
  render,
  children,
  className,
}: {
  render: ReactElement;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button
      variant="link"
      size="xl"
      data-slot="back-link"
      className={cn('self-start px-0', className)}
      render={render}
    >
      <ArrowRightIcon className="ltr:rotate-180" strokeWidth={1.75} aria-hidden="true" />
      {children}
    </Button>
  );
}

export { BackLink };
