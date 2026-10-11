import {
  ACTIVITY_DELAY_MINUTES,
  ACTIVITY_ITEMS,
  ACTIVITY_WINDOW_HOURS,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';

/*
 * Live activity (S14 LA1–LA3), read here so the api `content` module shows real deliveries
 * without reading the order and catalog tables itself.
 */

type Executor = Database | Transaction;

export interface ActivityRow {
  gameSlug: string;
  gameNameAr: string;
  productNameAr: string;
  quantity: number;
  durationSeconds: number;
  /** Exact: the caller floors it (LA4) before it leaves the API. */
  deliveredAt: Date;
}

/**
 * Rule LA1: delivered orders of real customers, at least 5 minutes and at most 24 hours old, of an
 * unarchived product of a shown game (S09 SF1); store-wide or one game's. Returns the qualifying
 * count (LA3) and the newest 10, newest first.
 */
export async function liveActivity(
  db: Executor,
  options: { now: Date; gameSlug?: string },
): Promise<{ count: number; items: ActivityRow[] }> {
  const latest = new Date(options.now.getTime() - ACTIVITY_DELAY_MINUTES * 60_000);
  const earliest = new Date(options.now.getTime() - ACTIVITY_WINDOW_HOURS * 3_600_000);
  const game = options.gameSlug === undefined ? sql`` : sql`and g.slug = ${options.gameSlug}`;
  const qualifying = sql`
    from orders o
    join catalog_products p on p.id = o.product_id
    join catalog_games g on g.id = o.game_id
    join catalog_categories c on c.id = g.category_id
    where o.status = 'delivered' and not o.is_test
      and o.delivered_at <= ${latest.toISOString()}::timestamptz
      and o.delivered_at > ${earliest.toISOString()}::timestamptz
      and p.archived_at is null
      and g.status = 'active' and g.archived_at is null and c.archived_at is null
      ${game}`;
  const [counted, rows] = await Promise.all([
    db.execute<{ count: number }>(sql`select count(*)::int as count ${qualifying}`),
    db.execute<{
      game_slug: string;
      game_name_ar: string;
      product_name_ar: string;
      quantity: number;
      duration_seconds: number;
      delivered_at: string;
    }>(sql`
      select g.slug as game_slug, g.name_ar as game_name_ar, p.name_ar as product_name_ar,
        o.quantity,
        greatest(0, floor(extract(epoch from o.delivered_at - o.paid_at)))::int as duration_seconds,
        o.delivered_at::text as delivered_at
      ${qualifying}
      order by o.delivered_at desc, o.id desc
      limit ${ACTIVITY_ITEMS}`),
  ]);
  return {
    count: counted.rows[0]?.count ?? 0,
    items: rows.rows.map((row) => ({
      gameSlug: row.game_slug,
      gameNameAr: row.game_name_ar,
      productNameAr: row.product_name_ar,
      quantity: row.quantity,
      durationSeconds: row.duration_seconds,
      deliveredAt: new Date(row.delivered_at),
    })),
  };
}
