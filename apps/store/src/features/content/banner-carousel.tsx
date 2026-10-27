'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import {
  Children,
  type FocusEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/** S14 SL2, owner 2026-10-19: the next banner every 3 seconds. */
const ADVANCE_MS = 3_000;
/** How long after the last scroll event the track counts as settled (no `scrollend` support). */
const SETTLE_MS = 120;

/**
 * Scrolls the track alone so a slide sits in its middle: `scrollIntoView` would scroll the page
 * too, pulling a visitor who scrolled past the banners back up. A relative `scrollBy` from the
 * slides' boxes works the same in RTL, whose offsets are negative.
 */
function center(track: HTMLElement, slide: Element | undefined, behavior: ScrollBehavior) {
  if (!slide) return;
  const box = slide.getBoundingClientRect();
  const frame = track.getBoundingClientRect();
  track.scrollBy({
    left: box.left + box.width / 2 - (frame.left + frame.width / 2),
    behavior,
  });
}

/** The slide whose middle is nearest the track's middle. */
function nearest(track: HTMLElement): number {
  const frame = track.getBoundingClientRect();
  const middle = frame.left + frame.width / 2;
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  Array.from(track.children).forEach((slide, index) => {
    const box = slide.getBoundingClientRect();
    const away = Math.abs(box.left + box.width / 2 - middle);
    if (away < distance) {
      distance = away;
      best = index;
    }
  });
  return best;
}

/** The middle slide in full; its neighbours peek on both sides, smaller and dimmed. */
const slideClass =
  'shrink-0 basis-[86%] snap-center overflow-hidden rounded-xl transition-[opacity,scale] duration-500 ease-out data-[active=false]:scale-[0.93] data-[active=false]:opacity-45 sm:basis-[72%] lg:basis-[62%]';

const arrow =
  'absolute top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-float transition-colors hover:bg-muted sm:flex';

/**
 * The banners' carousel (S14 SL2, redesigned 2026-10-19): the current banner in the middle with
 * its neighbours peeking on both sides, dimmed; an endless loop (a hidden copy of the slides on
 * each side, the track moved back to the real ones once it settles), CSS scroll-snap for swiping,
 * arrows from `sm`, and dots whose current one fills over the 3 seconds. Advances while visible,
 * paused while hovered, focused from the keyboard or touched, never under `prefers-reduced-motion`
 * (which also moves without a smooth scroll). The slides are rendered on the server and passed in
 * as children; the copies join after hydration, so the server's page starts on the first banner
 * in full (audit A08-34).
 */
export function BannerCarousel({
  label,
  dotLabels,
  previousLabel,
  nextLabel,
  children,
}: {
  label: string;
  dotLabels: string[];
  previousLabel: string;
  nextLabel: string;
  children: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const slides = Children.toArray(children);
  const count = slides.length;
  // Positions run over the three copies; the real slides are count … 2 × count − 1.
  const [position, setPosition] = useState(count);
  const [ready, setReady] = useState(false);
  // Snapping starts once the first real slide is centred: snapping while the copies join would
  // re-snap the track to a neighbour of the slide it was on (audit A08-34).
  const [centred, setCentred] = useState(false);
  // Each reason to pause on its own, so ending one never resumes over another (audit A08-36).
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const paused = hovered || focused || touched;
  const [still, setStill] = useState(false);
  const [visible, setVisible] = useState(true);
  const current = ((position % count) + count) % count;

  const settleTimer = useRef(0);

  /** Moves the track, unseen, from a copy to the same real slide; answers where it now is. */
  const toReal = useCallback(
    (element: HTMLElement): number => {
      const at = nearest(element);
      if (at >= count && at < 2 * count) return at;
      const real = at < count ? at + count : at - count;
      // The real slide was a dimmed neighbour until now: it takes the full look at once, or it
      // would fade in from the side's look and flicker. Transitions return after the next paint.
      element.dataset.jumping = '';
      center(element, element.children[real], 'instant');
      setPosition(real);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          delete element.dataset.jumping;
        }),
      );
      return real;
    },
    [count],
  );

  /**
   * Moves `by` slides from the current one. It starts from the real slides first and cancels a
   * pending settle, so a press that lands as the loop wraps never ends on the wrong banner.
   */
  const step = useCallback(
    (by: number) => {
      const element = track.current;
      if (!element) return;
      window.clearTimeout(settleTimer.current);
      center(element, element.children[toReal(element) + by], still ? 'instant' : 'smooth');
    },
    [toReal, still],
  );

  // The copies join once hydrated; reduced motion is followed as it changes (audit A08-37).
  useEffect(() => {
    setReady(count > 1);
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setStill(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [count]);

  // Start on the first real slide, with a copy on each side, once the track has a width: a
  // carousel hydrated inside a streamed boundary that is still hidden measures nothing (A08-34).
  useLayoutEffect(() => {
    const element = track.current;
    if (!ready || !element) return;
    const start = () => {
      center(element, element.children[count], 'instant');
      setCentred(true);
    };
    if (element.clientWidth > 0) {
      start();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === 0) return;
      observer.disconnect();
      start();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, count]);

  // Follow the scroll; once it settles in a copy, jump to the same real slide unseen.
  useEffect(() => {
    const element = track.current;
    if (!element || !ready) return;
    const onScroll = () => {
      setPosition(nearest(element));
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => toReal(element), SETTLE_MS);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      window.clearTimeout(settleTimer.current);
    };
  }, [ready, toReal]);

  // A hidden tab arms no timer; coming back arms a fresh one, so the loop never stalls.
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `position` restarts the wait after every move, whoever made it
  useEffect(() => {
    // Armed once centred: a timer firing on a track still without a width moves nothing and would
    // never be armed again (audit A08-34).
    if (!centred || paused || still || !visible) return;
    const timer = window.setTimeout(() => step(1), ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [centred, paused, still, visible, position, step]);

  if (count < 2) {
    return (
      <section aria-label={label} data-testid="banner-carousel">
        {slides}
      </section>
    );
  }

  // Before hydration the real slides alone, the first one in full; after it, a copy on each side.
  const copies = ready ? [...slides, ...slides, ...slides] : slides;
  const offset = ready ? 0 : count;
  // A tap focuses the dot it pressed: only a keyboard focus holds the carousel.
  const keyboardFocus = (event: FocusEvent) =>
    event.target instanceof Element && event.target.matches(':focus-visible');
  return (
    <section
      aria-roledescription="carousel"
      aria-label={label}
      data-testid="banner-carousel"
      className="relative flex flex-col gap-3"
      onPointerEnter={(event) => event.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={(event) => event.pointerType === 'mouse' && setHovered(false)}
      onFocus={(event) => setFocused(keyboardFocus(event))}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setFocused(false)}
      onTouchStart={() => setTouched(true)}
      onTouchEnd={() => setTouched(false)}
      onTouchCancel={() => setTouched(false)}
    >
      <div className="relative">
        <div
          ref={track}
          data-slot="banner-track"
          className={`flex gap-3 overflow-x-auto data-jumping:*:transition-none overscroll-x-contain py-1 [scrollbar-width:none] sm:gap-4 ${centred ? 'snap-x snap-mandatory' : ''}`}
        >
          {copies.map((slide, at) => {
            const index = at + offset;
            return index >= count && index < 2 * count ? (
              // biome-ignore lint/a11y/useSemanticElements: the ARIA carousel pattern's slide is a group
              <div
                key={index}
                role="group"
                aria-roledescription="slide"
                aria-label={dotLabels[index - count]}
                data-active={index === position}
                className={slideClass}
              >
                {slide}
              </div>
            ) : (
              // The copies are for the eye only: out of the accessibility tree and the tab order.
              <div
                key={index}
                aria-hidden="true"
                inert
                data-active={index === position}
                className={slideClass}
              >
                {slide}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={previousLabel}
          className={`${arrow} start-3`}
          onClick={() => step(-1)}
        >
          <ChevronRightIcon className="size-5 ltr:-scale-x-100" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={nextLabel}
          className={`${arrow} end-3`}
          onClick={() => step(1)}
        >
          <ChevronLeftIcon className="size-5 ltr:-scale-x-100" aria-hidden="true" />
        </button>
      </div>
      <div className="flex justify-center">
        {dotLabels.map((dotLabel, index) => (
          <button
            key={dotLabel}
            type="button"
            aria-label={dotLabel}
            aria-current={index === current ? 'true' : undefined}
            className="group flex h-11 min-w-11 items-center justify-center px-1"
            onClick={() => step(index - current)}
          >
            <span
              className={`relative block h-1.5 overflow-hidden rounded-full transition-all duration-300 ${
                index === current
                  ? 'w-8 bg-border'
                  : 'w-1.5 bg-border group-hover:bg-muted-foreground'
              }`}
            >
              {index === current && (
                <span
                  // A new element per slide, and on coming back to the tab, restarts the fill with the timer.
                  key={`${position}:${visible}`}
                  className={`absolute inset-y-0 start-0 rounded-full bg-primary ${
                    still
                      ? 'w-full'
                      : `animate-[vd-banner-progress_3s_linear_forwards] ${paused || !visible ? '[animation-play-state:paused]' : ''}`
                  }`}
                />
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
