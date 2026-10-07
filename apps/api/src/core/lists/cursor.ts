import { CodedException } from '../errors/index.js';

/*
 * The opaque cursor of a newest-first list (ADR 0011, S01): the sort time and id of the last item
 * of a page, so the next page starts strictly after it even when times are equal.
 */

export interface CursorPosition {
  at: Date;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.at.toISOString(), position.id])).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const date = new Date(String(at));
    if (typeof id !== 'string' || Number.isNaN(date.getTime())) throw new Error('bad cursor');
    return { at: date, id };
  } catch {
    throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid cursor', [
      { path: ['cursor'], message: 'Invalid cursor' },
    ]);
  }
}

/** The page of `rows` fetched with one extra row, and the cursor of the next page if any. */
export function pageOf<Row>(
  rows: Row[],
  limit: number,
  positionOf: (row: Row) => CursorPosition,
): { items: Row[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(positionOf(last)) : null,
  };
}
