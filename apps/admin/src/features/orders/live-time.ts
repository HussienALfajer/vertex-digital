import type { LiveColumn, LiveOrderCard } from '@vertex-digital/contracts';

/*
 * The live room's clock (S11 rules LR3, LR6): computed in the panel from the card's times, so the
 * colors and the elapsed time change every second without a refetch.
 */

const pad = (value: number) => String(value).padStart(2, '0');

/** Elapsed time as `mm:ss`, then `h:mm:ss` from an hour (Latin digits, read left to right). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Since the customer paid: the time the slow rule measures (LR3). */
export const elapsedMs = (card: LiveOrderCard, now: number) =>
  now - new Date(card.paidAt).getTime();

/** Rule LR3: an order at the supplier past its product's measured delivery time. */
export function isSlow(card: LiveOrderCard, now: number): boolean {
  return card.slowAfterSeconds !== null && elapsedMs(card, now) > card.slowAfterSeconds * 1000;
}

/** A finished card's delivery time: from payment to the end. */
export function finishedInMs(card: LiveOrderCard): number | null {
  return card.finishedAt === null
    ? null
    : new Date(card.finishedAt).getTime() - new Date(card.paidAt).getTime();
}

/** Rule LR6: the orders that need the admin, by id, from the board's two columns. */
export function waitingIds(columns: Record<LiveColumn, { cards: LiveOrderCard[] }>): Set<string> {
  return new Set([...columns.review.cards, ...columns.manual.cards].map((card) => card.id));
}

/** Rule LR6: whether a read shows an order new to "review" or "manual" since the one before. */
export function hasNewWaiting(previous: Set<string> | null, next: Set<string>): boolean {
  if (previous === null) return false;
  for (const id of next) if (!previous.has(id)) return true;
  return false;
}
