import {
  type AuditAction,
  type AuditDetails,
  type AuditEntityType,
  type CatalogImage,
  type CatalogMissingItem,
  type Category,
  catalogImagePath,
  type InputField,
  missingForActivation,
  type Product,
  productAvailability,
} from '@vertex-digital/contracts';
import {
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';

/*
 * Shared by the catalog services: rows to responses, refusals with their codes, and the audit
 * entry of a catalog change (S06).
 */

export type CategoryRow = typeof catalogCategories.$inferSelect;
export type GameRow = typeof catalogGames.$inferSelect;
export type FieldRow = typeof catalogInputFields.$inferSelect;
export type ProductRow = typeof catalogProducts.$inferSelect;

/** Who changes the catalog: the admin, from the panel. */
export interface Actor {
  adminId: string;
  meta: RequestMeta;
}

export const isUuid = (value: string) => z.uuid().safeParse(value).success;

const record = (row: {
  id: string;
  sortOrder: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id,
  sortOrder: row.sortOrder,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export function toCategory(row: CategoryRow, gameCount: number): Category {
  return { ...record(row), slug: row.slug, nameAr: row.nameAr, gameCount };
}

export function toImage(id: string, size: { width: number; height: number }): CatalogImage {
  return { id, url: catalogImagePath(id), ...size };
}

export function toInputField(row: FieldRow): InputField {
  return {
    ...record(row),
    gameId: row.gameId,
    key: row.key,
    labelAr: row.labelAr,
    helpAr: row.helpAr,
    type: row.type,
    required: row.required,
    minLength: row.minLength,
    maxLength: row.maxLength,
    options: row.options,
  };
}

/** Where a product's game sits, for its availability (rule CT9). */
export interface GameFacts {
  categoryArchived: boolean;
  gameArchived: boolean;
  gameStatus: GameRow['status'];
}

export function toProduct(row: ProductRow, game: GameFacts): Product {
  return {
    ...record(row),
    gameId: row.gameId,
    kind: row.kind,
    nameAr: row.nameAr,
    gameAmount: row.gameAmount,
    officialPriceUsdUnits: row.officialPriceUsdUnits,
    maxQuantity: row.maxQuantity,
    regionAr: row.regionAr,
    redemptionAr: row.redemptionAr,
    status: row.status,
    availability: productAvailability({
      ...game,
      productArchived: row.archivedAt !== null,
      productStatus: row.status,
    }),
  };
}

export const refusals = {
  notFound: (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`),
  parentArchived: () =>
    new CodedException(409, 'PARENT_ARCHIVED', 'The category or game above it is archived'),
  incomplete: (missing: CatalogMissingItem[]) =>
    new CodedException(409, 'CATALOG_INCOMPLETE', 'The game cannot be active without these', {
      missing,
    }),
  limit: (limit: number) =>
    new CodedException(409, 'CATALOG_LIMIT_REACHED', `A game holds at most ${limit} of these`),
  invalid: (message: string) => new CodedException(400, 'VALIDATION_FAILED', message),
};

/** The refusal a unique index raised (rule CT1), or null for any other error. */
export function takenRefusal(error: unknown): CodedException | null {
  const constraint = violatedConstraint(error);
  if (constraint === null) return null;
  if (constraint.endsWith('_slug_unique')) {
    return new CodedException(409, 'SLUG_TAKEN', 'The slug is used, archived rows included');
  }
  if (constraint === 'catalog_input_fields_game_id_key_idx') {
    return new CodedException(409, 'FIELD_KEY_TAKEN', 'The game already has a field with this key');
  }
  if (constraint.endsWith('_name_ar_live_idx')) {
    return new CodedException(409, 'NAME_TAKEN', 'An unarchived sibling has this name');
  }
  return null;
}

/** Runs a catalog write, turning a unique index violation into its coded refusal. */
export async function mapTaken<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    throw takenRefusal(error) ?? error;
  }
}

/** Refuses a reorder whose ids are not exactly the unarchived children (rule CT5). */
export function checkReorder(current: readonly string[], ids: readonly string[]): void {
  const expected = new Set(current);
  if (ids.length !== expected.size || !ids.every((id) => expected.has(id))) {
    throw refusals.invalid('The order must list every unarchived item exactly once');
  }
}

/** The fields whose value changed, before and after; null when nothing changed. */
export function changes<Values extends Record<string, unknown>>(
  before: Values,
  after: Partial<Values>,
): { before: Partial<Values>; after: Partial<Values> } | null {
  const keys = (Object.keys(after) as (keyof Values)[]).filter(
    (key) => after[key] !== undefined && JSON.stringify(after[key]) !== JSON.stringify(before[key]),
  );
  if (keys.length === 0) return null;
  return {
    before: Object.fromEntries(keys.map((key) => [key, before[key]])) as Partial<Values>,
    after: Object.fromEntries(keys.map((key) => [key, after[key]])) as Partial<Values>,
  };
}

/** The audit entry of a catalog change, in its transaction (S06 "Audit and notifications"). */
export function auditCatalog<Action extends AuditAction>(
  tx: Transaction,
  actor: Actor,
  action: Action,
  entity: { type: AuditEntityType; id: string },
  details: AuditDetails<Action>,
): Promise<string> {
  return recordAudit(tx, {
    action,
    actorKind: 'admin',
    actorId: actor.adminId,
    channel: 'admin',
    entityType: entity.type,
    entityId: entity.id,
    ipAddress: actor.meta.ipAddress,
    userAgent: actor.meta.userAgent,
    details,
  });
}

/**
 * Rule CT3 inside a change's transaction, after the change: an active game must have a cover and,
 * with an unarchived `direct` product, an unarchived required field. Throws `CATALOG_INCOMPLETE`,
 * which rolls the change back.
 */
export async function assertComplete(
  tx: Transaction,
  game: Pick<GameRow, 'id' | 'status' | 'coverFileId'>,
): Promise<void> {
  if (game.status !== 'active') return;
  const [facts] = await tx
    .select({
      hasDirectProduct: sql<boolean>`exists (select 1 from ${catalogProducts}
        where ${catalogProducts.gameId} = ${game.id} and ${catalogProducts.kind} = 'direct'
          and ${catalogProducts.archivedAt} is null)`,
      hasRequiredField: sql<boolean>`exists (select 1 from ${catalogInputFields}
        where ${catalogInputFields.gameId} = ${game.id} and ${catalogInputFields.required}
          and ${catalogInputFields.archivedAt} is null)`,
    })
    .from(catalogGames)
    .where(eq(catalogGames.id, game.id));
  const missing = missingForActivation({
    hasCover: game.coverFileId !== null,
    hasDirectProduct: facts?.hasDirectProduct ?? false,
    hasRequiredField: facts?.hasRequiredField ?? false,
  });
  if (missing.length > 0) throw refusals.incomplete(missing);
}

/** The next `sort_order` among a parent's unarchived children: new rows go last (rule CT5). */
export function nextSortOrder(
  tx: Transaction,
  table:
    | typeof catalogCategories
    | typeof catalogGames
    | typeof catalogInputFields
    | typeof catalogProducts,
  parent: SQL | undefined,
): Promise<number> {
  return tx
    .select({ next: sql<number>`coalesce(max(${table.sortOrder}), 0)::int + 1` })
    .from(table)
    .where(and(isNull(table.archivedAt), parent))
    .then(([row]) => row?.next ?? 1);
}

/** A `LIKE` pattern that finds `text` anywhere, its wildcards taken literally. */
export const containing = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

/** Rewrites `sort_order` as 1…n in the order of `ids` (rule CT5). */
export async function rewriteOrder(
  tx: Transaction,
  table:
    | typeof catalogCategories
    | typeof catalogGames
    | typeof catalogInputFields
    | typeof catalogProducts,
  ids: readonly string[],
): Promise<void> {
  await tx
    .update(table)
    .set({
      sortOrder: sql`(array_position(${sql.param([...ids])}::uuid[], ${table.id}))::int`,
    })
    .where(inArray(table.id, [...ids]));
}
