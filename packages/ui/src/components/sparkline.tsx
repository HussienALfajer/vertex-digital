import { cn } from '../lib/cn';

const WIDTH = 100;
const HEIGHT = 40;
/** Room above the highest point and below the lowest, so the line never touches the edges. */
const PAD_Y = 4;

interface Point {
  x: number;
  y: number;
}

/**
 * A smooth curve through the points that never overshoots them (monotone cubic, Fritsch–Carlson):
 * a day at zero stays on the baseline instead of dipping below it.
 */
function smoothPath(points: readonly Point[]): string {
  const [first] = points;
  if (!first) return '';
  if (points.length === 1) return `M${first.x},${first.y}`;
  const slopes = points.slice(1).map((point, index) => {
    const previous = points[index] as Point;
    return (point.y - previous.y) / (point.x - previous.x);
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0] as number;
    if (index === points.length - 1) return slopes[index - 1] as number;
    const before = slopes[index - 1] as number;
    const after = slopes[index] as number;
    return before * after <= 0 ? 0 : (before + after) / 2;
  });
  let path = `M${first.x},${first.y}`;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] as Point;
    const to = points[index] as Point;
    const third = (to.x - from.x) / 3;
    path += ` C${from.x + third},${from.y + (tangents[index - 1] as number) * third} ${to.x - third},${to.y - (tangents[index] as number) * third} ${to.x},${to.y}`;
  }
  return path;
}

/**
 * A small trend line without axes (the dashboard's 7-day sales, the reports): a smooth line over a
 * light fill down to zero, a faint baseline at zero, and the newest value marked with a dot. Points
 * are evenly spaced, the oldest on the left in both directions, as time reads in charts.
 */
function Sparkline({
  values,
  label,
  className,
  scale = 'zero',
}: {
  values: readonly number[];
  /** What the line shows, read by screen readers. */
  label: string;
  className?: string;
  /**
   * `zero` (counts, sales): the axis starts at zero, with its baseline. `range` (a price that moves
   * by a cent): the axis spans the lowest to the highest value, so small moves show; the fill runs
   * to the bottom and there is no zero line.
   */
  scale?: 'zero' | 'range';
}) {
  const fromZero = scale === 'zero';
  const max = fromZero ? Math.max(...values, 0) : Math.max(...values);
  const min = fromZero ? Math.min(...values, 0) : Math.min(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0;
  // A flat range line sits in the middle rather than on the floor.
  const yOf = (value: number) =>
    max === min && !fromZero
      ? HEIGHT / 2
      : HEIGHT - PAD_Y - ((value - min) / range) * (HEIGHT - PAD_Y * 2);
  const points = values.map((value, index) => ({ x: index * step, y: yOf(value) }));
  const zero = fromZero ? yOf(0) : HEIGHT;
  const line = smoothPath(points);
  const last = points.at(-1);
  return (
    <div
      data-slot="sparkline"
      role="img"
      aria-label={label}
      className={cn('relative h-12 w-full', className)}
    >
      {/* Stretched to the box: the strokes keep their width, the dot is drawn outside the SVG. */}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute inset-0 size-full overflow-visible"
      >
        {fromZero && (
          <line
            x1={0}
            x2={WIDTH}
            y1={zero}
            y2={zero}
            className="stroke-border"
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {last && points.length > 1 && (
          <path
            d={`${line} L${last.x},${zero} L0,${zero} Z`}
            className="fill-primary/10"
            stroke="none"
          />
        )}
        <path
          d={line}
          fill="none"
          className="stroke-primary"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {last && (
        <span
          aria-hidden="true"
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-surface"
          // Physical on purpose: the chart's time axis runs left to right in both directions.
          style={{ left: `${(last.x / WIDTH) * 100}%`, top: `${(last.y / HEIGHT) * 100}%` }}
        />
      )}
    </div>
  );
}

export { Sparkline };
