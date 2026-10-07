import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '../lib/cn';

/** An on/off setting that takes effect as a value of the form, such as a flag on a record. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-md border border-input bg-surface p-0.5',
        'transition-colors duration-150 ease-out',
        'data-checked:border-primary data-checked:bg-primary',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'block size-4.5 rounded-sm bg-muted-foreground transition-[translate,background-color] duration-150 ease-out',
          'data-checked:translate-x-4 data-checked:bg-primary-foreground rtl:data-checked:-translate-x-4',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
