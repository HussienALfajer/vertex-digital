import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cn } from '../lib/cn';

/**
 * A segmented set of toggle buttons: one value (a choice between few options) or several with
 * `multiple` (quick filters). The group needs an accessible name (`aria-label`).
 */
function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupPrimitive.Props<Value>) {
  return (
    <ToggleGroupPrimitive<Value>
      data-slot="toggle-group"
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5',
        'data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-sm px-3 text-sm whitespace-nowrap text-muted-foreground select-none',
        'transition-colors duration-150 ease-out hover:text-foreground',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // Pressed reads at a glance (WCAG 1.4.11): the primary fill, not a near-white step.
        'data-pressed:bg-primary data-pressed:font-medium data-pressed:text-primary-foreground data-pressed:hover:bg-primary-hover data-pressed:hover:text-primary-foreground',
        'data-disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
