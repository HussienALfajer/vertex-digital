'use client';

import { ChevronsRightIcon } from 'lucide-react';
import {
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent,
  useRef,
  useState,
} from 'react';
import { AscentLines } from '../brand/ascent-lines';
import { cn } from '../lib/cn';
import { useDirection } from './direction-provider';

/** Released past this share of the track, the slide confirms; earlier, it springs back. */
export const SLIDE_CONFIRM_THRESHOLD = 0.85;

/** One arrow key press moves the handle this share of the track. */
export const SLIDE_KEY_STEP = 0.25;

/** Whether a release at `progress` (0–1) confirms. */
export function slideConfirms(progress: number): boolean {
  return progress >= SLIDE_CONFIRM_THRESHOLD;
}

/**
 * The keyboard path: `End` confirms; the arrow pointing along the slide (left in RTL) moves the
 * handle forward and confirms once it reaches the end; the other arrow and `Home` move it back.
 * Null for any other key.
 */
export function slideKey(
  key: string,
  progress: number,
  direction: 'ltr' | 'rtl',
): { progress: number; confirm: boolean } | null {
  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backward = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  if (key === 'End') return { progress: 1, confirm: true };
  if (key === 'Home') return { progress: 0, confirm: false };
  if (key === forward || key === 'ArrowUp') {
    const next = Math.min(1, progress + SLIDE_KEY_STEP);
    return { progress: next, confirm: next >= 1 };
  }
  if (key === backward || key === 'ArrowDown') {
    return { progress: Math.max(0, progress - SLIDE_KEY_STEP), confirm: false };
  }
  return null;
}

interface SlideToPayProps extends Omit<ComponentProps<'div'>, 'children' | 'onChange'> {
  /** The words in the track ("اسحب للدفع"); also the handle's accessible name. */
  label: string;
  /** What the handle announces as its value, e.g. "0%" (screen readers). */
  valueText?: (percent: number) => string;
  /** Called once when the slide confirms; remount the component (`key`) to slide again. */
  onConfirm: () => void;
  disabled?: boolean;
}

/**
 * Slide-to-pay (§5, §11; S09 rule BB5): a handle travels from the start edge (the right in RTL)
 * to the end edge over a track of 60° strokes that fill as it moves. Released past 85% of the
 * track it confirms; earlier it springs back. The handle is a `role="slider"`: `End`, or the
 * arrow keys to the end, confirm. A UX guard only: the server checks every purchase the same way.
 */
function SlideToPay({
  label,
  valueText = (percent) => `${percent}%`,
  onConfirm,
  disabled = false,
  className,
  ...props
}: SlideToPayProps) {
  const direction = useDirection();
  const track = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startProgress: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const locked = disabled || confirmed;

  function travel(): number {
    const width = track.current?.clientWidth ?? 0;
    const handleWidth = handle.current?.offsetWidth ?? 0;
    return Math.max(1, width - handleWidth - 8);
  }

  function confirm() {
    setProgress(1);
    setConfirmed(true);
    onConfirm();
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (locked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startProgress: progress };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const moved = (event.clientX - drag.current.startX) * (direction === 'rtl' ? -1 : 1);
    setProgress(Math.min(1, Math.max(0, drag.current.startProgress + moved / travel())));
  }

  function onPointerUp() {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (slideConfirms(progress)) confirm();
    else setProgress(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (locked) return;
    const next = slideKey(event.key, progress, direction);
    if (!next) return;
    event.preventDefault();
    if (next.confirm) confirm();
    else setProgress(next.progress);
  }

  const percent = Math.round(progress * 100);
  const offset = `calc(${progress} * (100% - 3.5rem))`;
  return (
    <div
      ref={track}
      data-slot="slide-to-pay"
      data-confirmed={confirmed || undefined}
      className={cn(
        'relative h-14 w-full touch-none overflow-hidden rounded-lg border border-border bg-muted select-none',
        disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 start-0 overflow-hidden bg-accent/20 text-accent',
          !dragging && 'transition-[width] duration-250 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
        )}
        style={{ width: `calc(${offset} + 3.25rem)` }}
      >
        <AscentLines className="h-full w-[200%] opacity-60" />
      </div>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center ps-14 text-md font-bold text-foreground"
      >
        {label}
      </span>
      <div
        ref={handle}
        role="slider"
        tabIndex={locked ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText(percent)}
        aria-disabled={locked || undefined}
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute inset-y-1 start-1 flex w-12 cursor-grab items-center justify-center rounded-md bg-primary text-primary-foreground outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted',
          locked && 'cursor-default',
          !dragging &&
            'transition-[inset-inline-start] duration-250 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
        )}
        style={{ insetInlineStart: `calc(${offset} + 0.25rem)` }}
      >
        <ChevronsRightIcon className="size-5 rtl:-scale-x-100" aria-hidden="true" />
      </div>
    </div>
  );
}

export { SlideToPay, type SlideToPayProps };
