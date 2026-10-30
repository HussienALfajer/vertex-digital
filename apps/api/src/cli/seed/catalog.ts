import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Database,
  newId,
  repriceProducts,
  seedRootListRules,
  type Transaction,
} from '@vertex-digital/db';
import { type FakeSupplierState, fakeSupplierStateSchema } from '@vertex-digital/suppliers';
import { sql } from 'drizzle-orm';

/*
 * The catalog of `db:seed-local`: the production snapshot written by
 * `scripts/pull-catalog-snapshot.sh` (categories, games, fields, products, margin rules, the price
 * history, the real suppliers' offers, tree and routes, the newest policies, the games' images),
 * loaded as it is, but for the rows of price lists this database lacks: production's merchant tier
 * lists are created here later, with ids of their own, by `setupMerchantTiers`, which writes their
 * rules and prices. Then every live WDGZone route gets a twin on the fake supplier (`mirror-<id>`,
 * same cost, fields and maps, a lower priority) that becomes the price basis, so the local store
 * sells the production catalog through the fake while WDGZone stays paused.
 */

/** Loaded in this order: each table's foreign keys point to tables above it. */
const TABLES = [
  'stored_files',
  'catalog_categories',
  'catalog_games',
  'catalog_input_fields',
  'catalog_products',
  'margin_rules',
  'supplier_offers',
  'supplier_categories',
  'product_routes',
  'price_reviews',
  'product_prices',
  'supplier_policy',
  'order_policy',
] as const;

/** Append-only tables: a row already there is kept, never updated. */
const INSERT_ONLY = new Set(['stored_files', 'product_prices', 'supplier_policy', 'order_policy']);

/**
 * Columns a row keeps when the snapshot updates it: a margin rule keeps what it applies to and when
 * it was made (guard 0099), so the migration's seeded wholesale rule takes only its values.
 */
const KEPT_ON_UPDATE: Record<string, ReadonlySet<string>> = {
  margin_rules: new Set(['price_list_id', 'scope', 'target_id', 'created_at']),
};

/** Policies come in as the newest row, so they are stamped now. */
const STAMPED_NOW = new Set(['supplier_policy', 'order_policy']);

const CHUNK = 1_000;

const mirrorSchema = fakeSupplierStateSchema.shape.mirroredOffers.unwrap().element;

export const WDGZONE_SUPPLIER_ID = '01a11d3c-890b-70e7-8e09-9b5e1fa47e26';
export const FAKE_SUPPLIER_ID = '01a11d3c-890c-77e7-af29-41b711a8e367';

type Row = Record<string, unknown>;

interface SnapshotMeta {
  adminIds: string[];
}

export interface CatalogFiles {
  put(key: string, bytes: Buffer): Promise<void>;
}

export interface CatalogResult {
  rows: Record<string, number>;
  mirrored: number;
  repriced: number;
  mirroredOffers: FakeSupplierState['mirroredOffers'];
}

async function readTable(dir: string, table: string, adminId: string, adminIds: string[]) {
  let text = await readFile(join(dir, 'tables', `${table}.json`), 'utf8');
  // Production's admin becomes the local one, so the panel names who did what.
  for (const id of adminIds) text = text.replaceAll(id, adminId);
  return JSON.parse(text) as Row[];
}

async function upsert(tx: Transaction, table: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0] as Row);
  const conflict = INSERT_ONLY.has(table)
    ? 'DO NOTHING'
    : `DO UPDATE SET ${columns
        .filter((column) => column !== 'id' && !KEPT_ON_UPDATE[table]?.has(column))
        .map((column) => `"${column}" = EXCLUDED."${column}"`)
        .join(', ')}`;
  // Only the snapshot's own columns: one taken before a migration leaves the new columns to their
  // defaults (S20: a pre-S20 snapshot's rules and prices are retail's).
  const list = columns.map((column) => `"${column}"`).join(', ');
  for (let at = 0; at < rows.length; at += CHUNK) {
    const chunk = rows.slice(at, at + CHUNK);
    await tx.execute(
      sql.raw(
        `INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", '${JSON.stringify(
          chunk,
        ).replaceAll("'", "''")}'::json) ON CONFLICT (id) ${conflict}`,
      ),
    );
  }
}

/** Loads the snapshot in one transaction, then mirrors and reprices. */
export async function loadCatalog(
  db: Database,
  files: CatalogFiles,
  input: { dir: string; adminId: string; now: Date },
): Promise<CatalogResult> {
  const meta = JSON.parse(await readFile(join(input.dir, 'meta.json'), 'utf8')) as SnapshotMeta;
  const tables = new Map<string, Row[]>();
  for (const table of TABLES) {
    const rows = await readTable(input.dir, table, input.adminId, meta.adminIds);
    tables.set(
      table,
      STAMPED_NOW.has(table)
        ? rows.map((row) => ({ ...row, id: newId(), created_at: input.now.toISOString() }))
        : rows,
    );
  }
  for (const file of tables.get('stored_files') ?? []) {
    const key = file.storage_key as string;
    await files.put(key, await readFile(join(input.dir, 'files', key)));
  }

  const result: CatalogResult = { rows: {}, mirrored: 0, repriced: 0, mirroredOffers: [] };
  await db.transaction(async (tx) => {
    const lists = new Set(
      (await tx.execute<{ id: string }>(sql`SELECT id FROM price_lists`)).rows.map((row) => row.id),
    );
    for (const table of TABLES) {
      // A snapshot taken before S20 has no list column: its rows take the retail default.
      const rows = (tables.get(table) ?? []).filter(
        (row) => row.price_list_id === undefined || lists.has(row.price_list_id as string),
      );
      await upsert(tx, table, rows);
      result.rows[table] = rows.length;
    }

    const offers = new Map(
      (tables.get('supplier_offers') ?? []).map((offer) => [offer.id as string, offer]),
    );
    const mirrorOffers: Row[] = [];
    const mirrorRoutes: Row[] = [];
    for (const route of tables.get('product_routes') ?? []) {
      if (route.supplier_id !== WDGZONE_SUPPLIER_ID || route.archived_at !== null) continue;
      const offer = offers.get(route.offer_id as string);
      if (!offer || offer.unsupported_reason !== null) continue;
      const offerId = `mirror-${offer.offer_id as string}`;
      // Only packs the fake can serve as the worker reads its state (names, ids, fields).
      const mirror = mirrorSchema.safeParse({
        offerId,
        categoryId: offer.category_id ?? 'mirror',
        group: offer.group_name ?? 'WDGZone',
        name: offer.name,
        kind: offer.kind === 'code' ? 'code' : 'direct',
        costUsdUnits: offer.cost_usd_units,
        fieldSpecs: offer.field_specs ?? [],
      });
      if (!mirror.success) continue;
      const mirrorId = newId();
      const at = input.now.toISOString();
      mirrorOffers.push({
        ...offer,
        id: mirrorId,
        supplier_id: FAKE_SUPPLIER_ID,
        offer_id: offerId,
        in_stock: true,
        stock: null,
        cost_raw: null,
        cost_confirmed_at: at,
        last_seen_at: at,
        missing_since: null,
        ignored_at: null,
        ignored_admin_id: null,
        stock_alert: null,
        created_at: at,
        updated_at: at,
      });
      mirrorRoutes.push({
        ...route,
        id: newId(),
        supplier_id: FAKE_SUPPLIER_ID,
        offer_id: mirrorId,
        price_basis: true,
        // A route's own hard limit only, so the policy's expected time never meets it.
        expected_delivery_minutes: null,
        created_at: at,
        updated_at: at,
      });
      result.mirroredOffers.push(mirror.data);
    }
    // The twins come first at the same cost and carry the price; the WDGZone routes go one rank
    // down. WDGZone stays paused, so they serve nothing locally until a key and a resume.
    await tx.execute(
      sql`UPDATE product_routes SET price_basis = false, priority = least(priority + 1, 9)
        WHERE supplier_id = ${WDGZONE_SUPPLIER_ID}`,
    );
    await upsert(tx, 'supplier_offers', mirrorOffers);
    await upsert(tx, 'product_routes', mirrorRoutes);
    result.mirrored = mirrorRoutes.length;
  });
  return result;
}

/** Reprices every product once the fake supplier is configured (its routes are then usable). */
export async function repriceCatalog(db: Database, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    // S20: the wholesale and cost rules, as `pricing:reprice-lists` adds them after a deploy.
    await seedRootListRules(tx);
    const ids = (
      await tx.execute<{ id: string }>(
        sql`SELECT id FROM catalog_products WHERE archived_at IS NULL ORDER BY id`,
      )
    ).rows.map((row) => row.id);
    const result = await repriceProducts(tx, {
      productIds: ids,
      cause: 'route_change',
      context: { now, fakeEnabled: true },
    });
    return result.repriced;
  });
}
