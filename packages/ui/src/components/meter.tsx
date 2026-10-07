import { Meter as MeterPrimitive } from '@base-ui/react/meter';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const meterFillVariants = cva('', {
  variants: {
    tone: {
      brand: 'bg-primary',
      success: 'bg-status-success-foreground',
      warning: 'bg-status-warning-foreground',
      danger: 'bg-destructive',
    },
  },
  defaultVariants: { tone: 'brand' },
});

type MeterTone = NonNullable<VariantProps<typeof meterFillVariants>['tone']>;

type MeterProps = Omit<MeterPrimitive.Root.Props, 'children'> & { tone?: MeterTone };

/**
 * A measured amount within a known range (a share of time elapsed, a completion rate). Needs an
 * accessible name (`aria-label` or `aria-labelledby`); the value is announced for it.
 */
function Meter({ tone, className, ...props }: MeterProps) {
  return (
    <MeterPrimitive.Root data-slot="meter" className={cn('w-full', className)} {...props}>
      <MeterPrimitive.Track className="block h-1.5 w-full overflow-hidden rounded-sm bg-muted">
        <MeterPrimitive.Indicator
          className={cn(
            'block h-full transition-[width] duration-200 ease-out motion-reduce:transition-none',
            meterFillVariants({ tone }),
          )}
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  );
}

const ascentMeterVariants = cva('flex items-end gap-1', {
  variants: {
    size: {
      sm: 'h-4 w-20',
      md: 'h-6 w-full',
    },
  },
  defaultVariants: { size: 'md' },
});

type AscentMeterProps = Omit<MeterPrimitive.Root.Props, 'children' | 'min'> &
  VariantProps<typeof ascentMeterVariants> & {
    /** The number of steps to reach, one bar each (milestones, committed deliverables). */
    max: number;
    tone?: MeterTone;
  };

/**
 * Steps toward a goal drawn as ascending bars at the logo's 60° angle (§5). Reached steps fill in
 * the tone; once every step is reached the summit turns sand, the brand's "goal met" moment.
 * Needs an accessible name (`aria-label` or `aria-labelledby`).
 */
function AscentMeter({ value, max, tone, size, className, ...props }: AscentMeterProps) {
  const steps = Math.max(max, 1);
  const reached = Math.min(Math.max(value, 0), steps);
  const summit = max > 0 && reached === steps;
  return (
    <MeterPrimitive.Root
      data-slot="ascent-meter"
      data-complete={summit || undefined}
      value={reached}
      max={steps}
      // Many steps close their gaps, so the bars still fit the meter's width.
      className={cn(ascentMeterVariants({ size }), steps > 12 && 'gap-px', className)}
      {...props}
    >
      {Array.from({ length: steps }, (_, index) => {
        const isReached = max > 0 && index < reached;
        const isSummit = summit && index === steps - 1;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: steps have no identity beyond their position
            key={index}
            aria-hidden="true"
            style={{ height: `${40 + (60 * (index + 1)) / steps}%` }}
            className={cn(
              'min-w-0.5 flex-1 -skew-x-30 transition-colors duration-200 ease-out motion-reduce:transition-none',
              isSummit ? 'bg-accent' : isReached ? meterFillVariants({ tone }) : 'bg-muted',
            )}
          />
        );
      })}
    </MeterPrimitive.Root>
  );
}

export { AscentMeter, type AscentMeterProps, Meter, type MeterProps, type MeterTone };
