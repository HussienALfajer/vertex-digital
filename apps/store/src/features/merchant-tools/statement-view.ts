import type { Statement, StatementEntry } from '@vertex-digital/contracts';

/*
 * The statement's screen (owner, 2026-10-30), apart from the official print and Excel: the month's
 * flow in four figures, the movements' chips, their search and their days. Pure; integer units.
 */

/** The month in four figures: opening, what came in, what went out (positive), closing. */
export function statementFlow(
  statement: Pick<Statement, 'openingUsdUnits' | 'closingUsdUnits' | 'entries'>,
) {
  let inUnits = 0;
  let outUnits = 0;
  for (const entry of statement.entries) {
    if (entry.amountUnits > 0) inUnits += entry.amountUnits;
    else outUnits -= entry.amountUnits;
  }
  return {
    openingUnits: statement.openingUsdUnits,
    inUnits,
    outUnits,
    closingUnits: statement.closingUsdUnits,
  };
}

/** The movements' chips: every kind the month holds, in this order. */
export const MOVEMENT_FILTERS = [
  'all',
  'deposit',
  'purchase',
  'refund',
  'adjustment',
  'other',
] as const;

export type MovementFilter = (typeof MOVEMENT_FILTERS)[number];

export function movementFilterOf(
  entry: Pick<StatementEntry, 'kind'>,
): Exclude<MovementFilter, 'all'> {
  return entry.kind === 'deposit' ||
    entry.kind === 'purchase' ||
    entry.kind === 'refund' ||
    entry.kind === 'adjustment'
    ? entry.kind
    : 'other';
}

/** The chips with a count, `all` first; a kind the month lacks has no chip. */
export function movementChips(
  entries: readonly StatementEntry[],
): { filter: MovementFilter; count: number }[] {
  return MOVEMENT_FILTERS.flatMap((filter) => {
    const count =
      filter === 'all'
        ? entries.length
        : entries.filter((entry) => movementFilterOf(entry) === filter).length;
    return filter === 'all' || count > 0 ? [{ filter, count }] : [];
  });
}

/** The orders an entry names: its own, or its checkout's. */
const ordersOf = (entry: StatementEntry) => [
  ...(entry.order ? [entry.order] : []),
  ...(entry.checkout?.orders ?? []),
];

/** Search by an order's number or a player's ID, whole or in part, any case. */
export function matchesMovement(entry: StatementEntry, query: string): boolean {
  const typed = query.trim().toLowerCase();
  if (typed === '') return true;
  return ordersOf(entry).some(
    (order) =>
      order.number.toLowerCase().includes(typed) ||
      order.fields.some((field) => field.value.toLowerCase().includes(typed)),
  );
}

const damascusDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The entries by Damascus day, newest day and newest entry first. */
export function movementDays(
  entries: readonly StatementEntry[],
): { day: string; entries: StatementEntry[] }[] {
  const days: { day: string; entries: StatementEntry[] }[] = [];
  for (const entry of [...entries].reverse()) {
    const day = damascusDay.format(new Date(entry.occurredAt));
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}

/** What a movement's title says (the screen's words, clearer than the kind's name). */
export type MovementTitle =
  | { key: 'deposit'; method: NonNullable<StatementEntry['deposit']>['method'] | null }
  | { key: 'purchase'; productNameAr: string | null }
  | { key: 'checkout'; count: number }
  | { key: 'refund' }
  | {
      key: 'adjustment';
      category: NonNullable<StatementEntry['adjustment']>['category'];
      credit: boolean;
      reversal: boolean;
    }
  | { key: 'other' };

export function movementTitle(entry: StatementEntry): MovementTitle {
  if (entry.kind === 'deposit') return { key: 'deposit', method: entry.deposit?.method ?? null };
  if (entry.kind === 'purchase') {
    return entry.checkout
      ? { key: 'checkout', count: entry.checkout.orders.length }
      : { key: 'purchase', productNameAr: entry.order?.productNameAr ?? null };
  }
  if (entry.kind === 'refund') return { key: 'refund' };
  if (entry.kind === 'adjustment' && entry.adjustment) {
    return {
      key: 'adjustment',
      category: entry.adjustment.category,
      credit: entry.amountUnits > 0,
      reversal: entry.adjustment.reversal,
    };
  }
  return { key: 'other' };
}
