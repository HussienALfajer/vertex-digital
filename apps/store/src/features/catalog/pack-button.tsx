'use client';

import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A pack card as a button (rule BB1): choosing an available pack opens the buy box; an
 * unavailable one is greyed in place and cannot be chosen (S06 CT9). The selected pack takes the
 * game's accent (brand/identity.md §6), the light theme's readable one there (`accentStyle`), and
 * a check mark, so the choice never rests on color alone (audit A8).
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
      className={`relative flex h-full w-full flex-col gap-2 rounded-lg border bg-surface p-3 text-start transition-colors duration-150 ${
        selected
          ? 'border-(--game-accent-light) outline-2 outline-(--game-accent-light) dark:border-(--game-accent) dark:outline-(--game-accent)'
          : 'border-border hover:border-(--game-accent-light) dark:hover:border-(--game-accent)'
      } ${available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
    >
      {children}
      {selected && (
        <span
          aria-hidden="true"
          className="absolute -top-2 -end-2 flex size-5 items-center justify-center rounded-full bg-(--game-accent-light) text-white dark:bg-(--game-accent) dark:text-green-950"
        >
          <CheckIcon className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}
