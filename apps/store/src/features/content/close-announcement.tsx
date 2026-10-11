'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { readDismissed, writeDismissed } from './dismissal';

const barOf = (button: HTMLButtonElement | null) =>
  button?.closest<HTMLElement>('[data-announcement]') ?? null;

/**
 * The bar's close button (S14 AN4): remembers `<id>:<revision>` on the device and hides its bar.
 * Without storage the bar closes for this page view only.
 */
export function CloseAnnouncement({
  storageKey,
  label,
  children,
}: {
  storageKey: string;
  label: string;
  children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);

  // The inline script hides a closed bar on load; this keeps it hidden if the bar is rendered again.
  useEffect(() => {
    const bar = barOf(button.current);
    if (bar && readDismissed() === storageKey) bar.hidden = true;
  }, [storageKey]);

  return (
    <button
      ref={button}
      type="button"
      aria-label={label}
      title={label}
      className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => {
        writeDismissed(storageKey);
        const bar = barOf(button.current);
        if (bar) bar.hidden = true;
      }}
    >
      {children}
    </button>
  );
}
