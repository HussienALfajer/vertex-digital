'use client';

import type { PlayerCheck } from '@vertex-digital/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValues } from './fields';
import { checkPlayer } from './requests';

/** Rule PV1: a check goes out after this long without typing, or when a field loses focus. */
export const PLAYER_CHECK_DELAY_MS = 800;

export type PlayerCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'done'; check: PlayerCheck };

/**
 * Rule PV6 as the customer reads it: a refused or failed call (a limit, the network) is
 * `unavailable`, so the customer confirms the id themselves (rule PV7).
 */
const UNAVAILABLE: PlayerCheck = { result: 'unavailable', reason: 'supplier' };

/**
 * The live player check of the buy box (rules PV1, PV7): only while `enabled` (a verified
 * customer, a pack that can be checked) and every required field passes (`values` not null);
 * after 800 ms without typing, or at once on `run()` (a field's blur, "متابعة"). Never per
 * keystroke, and the same values are never sent twice in one page visit.
 */
export function usePlayerCheck(
  productId: string,
  values: FieldValues | null,
  enabled: boolean,
): { state: PlayerCheckState; run: () => Promise<PlayerCheck | null> } {
  const answers = useRef(new Map<string, Promise<PlayerCheck>>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<PlayerCheckState>({ status: 'idle' });
  const key = enabled && values ? `${productId}:${JSON.stringify(values)}` : null;
  // The latest key and values, so `run` stays one function across renders.
  const current = useRef(key);
  current.current = key;
  const latestValues = useRef(values);
  latestValues.current = values;

  const run = useCallback(async (): Promise<PlayerCheck | null> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const asked = current.current;
    const fields = latestValues.current;
    if (!asked || !fields) return null;
    let answer = answers.current.get(asked);
    if (!answer) {
      setState({ status: 'checking' });
      answer = checkPlayer({ productId, fields }).then((result) =>
        result.ok ? result.data : UNAVAILABLE,
      );
      answers.current.set(asked, answer);
    }
    const check = await answer;
    if (current.current === asked) setState({ status: 'done', check });
    return check;
  }, [productId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key is the only trigger.
  useEffect(() => {
    if (!key) {
      setState({ status: 'idle' });
      return;
    }
    const known = answers.current.get(key);
    if (known) {
      void run();
      return;
    }
    // Changing a field clears the result (rule PV7) until the new values are checked.
    setState({ status: 'idle' });
    timer.current = setTimeout(() => void run(), PLAYER_CHECK_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key]);

  return { state, run };
}
