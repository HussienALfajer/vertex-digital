import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { cn } from '../lib/cn';

type ProgressProps = Omit<ProgressPrimitive.Root.Props, 'children'>;

/**
 * How far a running operation has got (an upload). Unlike `Meter`, the value moves toward done;
 * `value={null}` shows it as under way with no known amount. Needs an accessible name
 * (`aria-label` or `aria-labelledby`).
 */
function Progress({ className, ...props }: ProgressProps) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn('w-full', className)} {...props}>
      <ProgressPrimitive.Track className="block h-1.5 w-full overflow-hidden rounded-sm bg-muted">
        <ProgressPrimitive.Indicator className="block h-full bg-primary transition-[width] duration-200 ease-out data-indeterminate:w-1/3 data-indeterminate:animate-pulse motion-reduce:transition-none" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress, type ProgressProps };
