import { cn } from '../lib/cn';

const WIDTH = 100;
const HEIGHT = 32;
/** Room for the stroke and the last point's dot inside the box. */
const PAD = 3;

/**
 * A small trend line without axes (the dashboard's 7-day sales): points evenly spaced, the oldest
 * on the left and the newest marked with a dot, in both directions, as time reads in charts.
 */
function Sparkline({
  values,
  label,
  className,
}: {
  values: readonly number[];
  /** What the line shows, read by screen readers. */
  label: string;
  className?: string;
}) {
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = values.length > 1 ? (WIDTH - PAD * 2) / (values.length - 1) : 0;
  const points = values.map((value, index) => ({
    x: PAD + index * step,
    y: HEIGHT - PAD - ((value - min) / range) * (HEIGHT - PAD * 2),
  }));
  const last = points.at(-1);
  return (
    <svg
      data-slot="sparkline"
      role="img"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-label={label}
      className={cn('h-8 w-full overflow-visible', className)}
    >
      <polyline
        points={points.map((point) => `${point.x},${point.y}`).join(' ')}
        fill="none"
        className="stroke-primary"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {last && (
        <circle
          cx={last.x}
          cy={last.y}
          r={2.5}
          className="fill-primary"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export { Sparkline };
