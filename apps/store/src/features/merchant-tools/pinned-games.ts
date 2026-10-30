'use client';

import { PINNED_GAMES_MAX } from '@vertex-digital/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import type { Failure } from '@/lib/api';
import { getPinnedGames, savePinnedGames } from './requests';

/*
 * "ألعابك" (owner, 2026-10-30): the merchant's pinned games, read once per page load and shared by
 * every star, the row and its ordering dialog. A change shows at once and is saved as the whole
 * list; a refused save puts the list back as the server holds it and says why.
 */

export type PinnedState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; ids: readonly string[]; saving: boolean; error: Failure | null };

let state: PinnedState = { status: 'loading' };
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: PinnedState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the list once; again after a failed read (`retry`). */
export function loadPinnedGames(retry = false): Promise<void> {
  if (reading && !(retry && state.status === 'failed')) return reading;
  set({ status: 'loading' });
  reading = getPinnedGames().then((result) =>
    set(
      result.ok
        ? { status: 'ready', ids: result.data.gameIds, saving: false, error: null }
        : { status: 'failed' },
    ),
  );
  return reading;
}

export function usePinnedGames(): PinnedState {
  useEffect(() => {
    void loadPinnedGames();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

let saves = 0;

/** Saves `ids` as the whole ordered list; only the newest save's answer lands. */
export async function setPinnedGames(ids: readonly string[]): Promise<boolean> {
  if (state.status !== 'ready') return false;
  const before = state.ids;
  const save = ++saves;
  set({ status: 'ready', ids, saving: true, error: null });
  const result = await savePinnedGames({ gameIds: [...ids] });
  if (save !== saves) return result.ok;
  if (result.ok) {
    set({ status: 'ready', ids: result.data.gameIds, saving: false, error: null });
    return true;
  }
  set({ status: 'ready', ids: before, saving: false, error: result.reason });
  return false;
}

/** The star: pinned games leave the list, others join its end while it has room. */
export function togglePinned(gameId: string): Promise<boolean> {
  if (state.status !== 'ready') return Promise.resolve(false);
  const { ids } = state;
  if (ids.includes(gameId)) return setPinnedGames(ids.filter((id) => id !== gameId));
  if (ids.length >= PINNED_GAMES_MAX) return Promise.resolve(false);
  return setPinnedGames([...ids, gameId]);
}

/** Moves the game at `index` one place up (`-1`) or down (`1`). */
export function movePinned(ids: readonly string[], index: number, by: -1 | 1): string[] {
  const next = [...ids];
  const target = index + by;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target] as string, next[index] as string];
  return next;
}
