'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Seconds left before an action may run again (a new email code: one per 60 seconds, rule C5).
 * Starts counting at once; `restart` counts again from the start.
 */
export function useCountdown(seconds: number): { left: number; restart: () => void } {
  const [until, setUntil] = useState(() => Date.now() + seconds * 1000);
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [until]);

  const restart = useCallback(() => setUntil(Date.now() + seconds * 1000), [seconds]);
  return { left, restart };
}
