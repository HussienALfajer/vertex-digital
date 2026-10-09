import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** cot 60°: how far a stroke leans per unit of height (§5). */
const LEAN = 0.577;

const STROKES = [
  { x: 0, height: 18 },
  { x: 16, height: 30 },
  { x: 32, height: 42 },
];

const WIDTH = 9;

/**
 * The success moment (§6): the mark's three parallel 60° strokes rise one after the other, once,
 * in the current text color. `prefers-reduced-motion` shows them at rest (base.css). Decorative:
 * the page says what succeeded in words.
 */
function SuccessMark({ className, ...props }: Omit<ComponentProps<'svg'>, 'children' | 'viewBox'>) {
  return (
    <svg
      aria-hidden="true"
      data-slot="success-mark"
      viewBox="0 0 66 42"
      className={cn('w-16 shrink-0', className)}
      {...props}
    >
      {STROKES.map(({ x, height }, index) => {
        const lean = height * LEAN;
        const points = [
          `${x},42`,
          `${x + WIDTH},42`,
          `${x + WIDTH + lean},${42 - height}`,
          `${x + lean},${42 - height}`,
        ].join(' ');
        return (
          <polygon
            key={x}
            points={points}
            fill="currentColor"
            className="origin-bottom animate-[vd-stroke-rise_300ms_ease-out_both] [transform-box:fill-box]"
            style={{ animationDelay: `${index * 140}ms` }}
          />
        );
      })}
    </svg>
  );
}

export { SuccessMark };
