'use client';

import type { ReactNode } from 'react';

/**
 * A pack card as a button (rule BB1): choosing an available pack opens the buy box; an
 * unavailable one is greyed in place and cannot be chosen (S06 CT9). The selected pack takes the
 * game's accent (brand/identity.md §6).
 */
export function PackButton({
  available,
  selected,
  onSelect,
  children,
}: {
  available: boolean;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex h-full w-full flex-col gap-2 rounded-lg border bg-surface p-3 text-start transition-colors duration-150 ${
        selected
          ? 'border-(--game-accent) outline-2 outline-(--game-accent)'
          : 'border-border hover:border-(--game-accent)'
      } ${available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
    >
      {children}
    </button>
  );
}
