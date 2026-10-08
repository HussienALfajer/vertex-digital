'use client';

import { useEffect, useState } from 'react';

/** Seconds left until `iso`, every second; 0 once it passed. */
export function useTimeLeft(iso: string | null): number {
  const [left, setLeft] = useState(() => secondsUntil(iso));
  useEffect(() => {
    const tick = () => setLeft(secondsUntil(iso));
    tick();
    if (!iso) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return left;
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

/** `14:05` for minutes and seconds, `3:14:05` past an hour; Latin digits. */
export function formatClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
