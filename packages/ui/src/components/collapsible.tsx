import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '../lib/cn';

/** Content that can be shown and hidden by its trigger (a section folded on a phone). */
function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

/** The heading row that folds the panel; a chevron turns with the state. */
function CollapsibleTrigger({ className, children, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        'group flex w-full items-center gap-2 rounded-md text-start outline-offset-2 select-none',
        'transition-colors duration-150 ease-out hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon
        aria-hidden="true"
        className="ms-auto size-5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
      />
    </CollapsiblePrimitive.Trigger>
  );
}

function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn('flex flex-col', className)}
      {...props}
    />
  );
}

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
