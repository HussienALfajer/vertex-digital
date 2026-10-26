'use client';

import { useEffect, useState } from 'react';
import { serverNow } from '@/lib/server-clock';

/**
 * Seconds left until `iso` on the server's clock, every second; 0 once it passed. Read at each
 * render, so a time that just arrived (a deposit loaded) is right at once, never 0 for a frame.
 */
export function useTimeLeft(iso: string | null): number {
  const [, setTicks] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setTicks((ticks) => ticks + 1), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return secondsUntil(iso);
}

/**
 * Whether `iso` passed on the server's clock, with one timer set to that moment instead of a
 * render every second (audit A02-9: the whole deposit page ticked for this one boolean).
 */
export function useHasPassed(iso: string | null): boolean {
  const [, setPassed] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const left = new Date(iso).getTime() - serverNow();
    if (left <= 0) return;
    // A timer longer than 2^31 ms fires at once; the page reads the deposit long before anyway.
    const timer = setTimeout(
      () => setPassed((count) => count + 1),
      Math.min(left + 50, 2 ** 31 - 1),
    );
    return () => clearTimeout(timer);
  }, [iso]);
  return iso !== null && secondsUntil(iso) === 0;
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - serverNow()) / 1000));
}

/** `14:05` for minutes and seconds, `3:14:05` past an hour; Latin digits. */
export function formatClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
