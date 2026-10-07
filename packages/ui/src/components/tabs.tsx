import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cn } from '../lib/cn';

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-6', className)}
      {...props}
    />
  );
}

/**
 * A row of tabs on a hairline; scrolls sideways on narrow screens instead of wrapping. The hairline
 * is an inset shadow, inside the box, so the active marker covers it without overflowing downwards
 * (a border would leave the marker 1 px outside and show a vertical scrollbar).
 */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'flex w-full items-stretch gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * One tab. The active tab carries a 2 px marker on the hairline (§4 lines), in the primary color:
 * green in light, sand in dark.
 */
function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'relative flex h-11 shrink-0 items-center gap-2 rounded-t-md px-3 text-base whitespace-nowrap text-muted-foreground select-none',
        'transition-colors duration-150 ease-out hover:text-foreground',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-primary after:opacity-0 after:transition-opacity after:duration-150',
        'data-active:font-medium data-active:text-foreground data-active:after:opacity-100',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('flex flex-col gap-6 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
