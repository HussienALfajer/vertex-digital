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

/*
 * Paged lists (ADR 0011, first: S06 games): `page` from 1 and `pageSize`, with the total, for
 * screens that filter and jump between pages rather than load more.
 */

/** The query of a paged list. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/** A page of a paged list and the number of items across all pages. */
export const pagedListSchema = <Item extends z.ZodType>(item: Item, id: string) =>
  z
    .object({
      items: z.array(item),
      total: z.int().nonnegative(),
      page: z.int().min(1),
      pageSize: z.int().min(1),
    })
    .meta({ id });
