'use client';

import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { anyInFlight } from './in-flight';
import { shownAgainTracker } from './shown-again-tracker';

/** Counts the times this page was shown again after being hidden; 0 until the first. */
export function useShownAgain(): number {
  const [count, setCount] = useState(0);
  const tracker = useRef<ReturnType<typeof shownAgainTracker> | null>(null);
  tracker.current ??= shownAgainTracker(() => setCount((current) => current + 1), anyInFlight);
  // A passive effect, never a layout one: a Suspense boundary that shows its fallback (a lazy sheet
  // opening inside) also cleans up its layout effects, which would count as a re-show and throw the
  // state away. Only hiding the page cleans up passive effects.
  useEffect(() => {
    tracker.current?.shown();
    return () => tracker.current?.hidden();
  }, []);
  return count;
}

/**
 * Mounts `children` afresh each time the page is shown again: a form that navigated on success
 * keeps its busy state (it must: its idempotency key is freed, so a second press during the
 * navigation would pay twice), and coming back gets a new form with its server data read again.
 * Never reset a busy state any other way. A write still unanswered (`lib/in-flight.ts`) keeps the
 * form as it is. What the customer typed and must keep goes in a form draft (`lib/form-draft.ts`).
 */
export function FreshOnShow({ children }: { children: ReactNode }) {
  return <Fragment key={useShownAgain()}>{children}</Fragment>;
}
