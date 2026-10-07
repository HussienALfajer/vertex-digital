import { z } from 'zod';

/*
 * Cursor lists (S01: audit log, test customers): newest first, "load more" instead of pages. The
 * cursor is opaque to clients; the API encodes the last item's sort key in it.
 */

/** The query of a cursor list: where to continue and how many items. */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** A page of a cursor list; `nextCursor` is null on the last page. */
export const cursorPageSchema = <Item extends z.ZodType>(item: Item, id: string) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).meta({ id });
