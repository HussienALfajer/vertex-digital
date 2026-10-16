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
