import type { SupplierCode } from '@vertex-digital/contracts';
import { eq, inArray } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { gamePlayerChecks, suppliers } from '../schema/index.js';

type Executor = Database | Transaction;

/** S19 PC1: a game's check provider row with its supplier's code and quota. */
export interface PlayerCheckProvider {
  gameId: string;
  supplierId: string;
  supplierCode: SupplierCode;
  categoryId: string;
  fieldMap: Record<string, string>;
  optionMap: Record<string, Record<string, string>>;
  allowedRegions: string[];
  enabled: boolean;
  updatedAt: Date;
  /** S09 rule PV5: the provider's player checks a Damascus day. */
  validationDailyQuota: number;
}

/**
 * S19 PC1: the check provider rows of these games, enabled or not, keyed by game; shared by the
 * player checks (orders) and the store's per-pack flag (catalog).
 */
export async function playerCheckProviders(
  db: Executor,
  gameIds: readonly string[],
): Promise<Map<string, PlayerCheckProvider>> {
  if (gameIds.length === 0) return new Map();
  const rows = await db
    .select({
      row: gamePlayerChecks,
      supplierCode: suppliers.code,
      validationDailyQuota: suppliers.validationDailyQuota,
    })
    .from(gamePlayerChecks)
    .innerJoin(suppliers, eq(suppliers.id, gamePlayerChecks.supplierId))
    .where(inArray(gamePlayerChecks.gameId, [...new Set(gameIds)]));
  return new Map(
    rows.map(({ row, supplierCode, validationDailyQuota }) => [
      row.gameId,
      {
        gameId: row.gameId,
        supplierId: row.supplierId,
        supplierCode,
        categoryId: row.categoryId,
        fieldMap: row.fieldMap,
        optionMap: row.optionMap,
        allowedRegions: row.allowedRegions,
        enabled: row.enabled,
        updatedAt: row.updatedAt,
        validationDailyQuota,
      },
    ]),
  );
}
