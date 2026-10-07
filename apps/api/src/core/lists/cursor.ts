import { type AnyColumn, and, lt, or, type SQL, sql } from 'drizzle-orm';
import { CodedException } from '../errors/index.js';

/*
 * The opaque cursor of a newest-first list (ADR 0011, S01): the sort time and id of the last item
 * of a page, so the next page starts strictly after it even when times are equal. The time is the
 * database's own text, with its microseconds: a JavaScript date keeps milliseconds only, and a
 * cursor rounded to them would skip rows.
 */

export interface CursorPosition {
  /** `timestamptz` as PostgreSQL writes it (`<column>::text`). */
  at: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

/** The column as text, to select next to each row for its cursor. */
export const cursorTime = (column: AnyColumn) => sql<string>`${column}::text`;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.at, position.id])).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof at !== 'string' || !TIMESTAMP.test(at) || typeof id !== 'string') {
      throw new Error('bad cursor');
    }
    return { at, id };
  } catch {
    throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid cursor', [
      { path: ['cursor'], message: 'Invalid cursor' },
    ]);
  }
}

/** Rows strictly after the cursor in `time desc, id desc` order. */
export function after(time: AnyColumn, id: AnyColumn, cursor: CursorPosition): SQL | undefined {
  return or(
    sql`${time} < ${cursor.at}::timestamptz`,
    and(sql`${time} = ${cursor.at}::timestamptz`, lt(id, cursor.id)),
  );
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
