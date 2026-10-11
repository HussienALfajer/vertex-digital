'use client';

import { Children, type ReactNode, useEffect, useRef, useState } from 'react';

/** S14 SL2: the next banner every 6 seconds. */
const ADVANCE_MS = 6_000;

/**
 * Scrolls the track alone to a slide: `scrollIntoView` would scroll the page too, pulling a visitor
 * who scrolled past the banners back up. RTL tracks scroll to negative offsets.
 */
function show(track: HTMLDivElement | null, index: number) {
  if (!track) return;
  const sign = getComputedStyle(track).direction === 'rtl' ? -1 : 1;
  track.scrollTo({ left: sign * index * track.clientWidth, behavior: 'smooth' });
}

/**
 * The banners' carousel (S14 SL2): CSS scroll-snap with dots; advances every 6 seconds, paused
 * while hovered, focused or touched, and never under `prefers-reduced-motion`. The slides are
 * rendered on the server and passed in as children.
 */
export function BannerCarousel({
  label,
  dotLabels,
  children,
}: {
  label: string;
  dotLabels: string[];
  children: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const slides = Children.toArray(children);
  const count = slides.length;

  useEffect(() => {
    if (count < 2 || paused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') show(track.current, (current + 1) % count);
    }, ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [count, current, paused]);

  return (
    <section
      aria-roledescription="carousel"
      aria-label={label}
      data-testid="banner-carousel"
      className="flex flex-col gap-2"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={(event) => event.pointerType === 'mouse' && setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setPaused(false)}
      onTouchStart={() => setPaused(true)}
    >
      <div
        ref={track}
        className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-lg [scrollbar-width:none]"
        onScroll={(event) => {
          const { scrollLeft, clientWidth } = event.currentTarget;
          // RTL scrolls to negative offsets in every current browser.
          const index = Math.round(Math.abs(scrollLeft) / Math.max(1, clientWidth));
          if (index !== current) setCurrent(Math.min(count - 1, index));
        }}
      >
        {slides.map((slide, index) => (
          // biome-ignore lint/a11y/useSemanticElements: the ARIA carousel pattern's slide is a group
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the slides keep their server order
            key={index}
            role="group"
            aria-roledescription="slide"
            aria-label={dotLabels[index]}
            className="w-full shrink-0 snap-start"
          >
            {slide}
          </div>
        ))}
      </div>
      {count > 1 && (
        <div className="flex justify-center">
          {dotLabels.map((dotLabel, index) => (
            <button
              key={dotLabel}
              type="button"
              aria-label={dotLabel}
              aria-current={index === current ? 'true' : undefined}
              className="group flex size-11 items-center justify-center"
              onClick={() => show(track.current, index)}
            >
              <span
                className={`block h-2 rounded-full transition-all ${
                  index === current
                    ? 'w-6 bg-primary'
                    : 'w-2 bg-border group-hover:bg-muted-foreground'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
