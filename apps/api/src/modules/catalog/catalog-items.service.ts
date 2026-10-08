import { Inject, Injectable } from '@nestjs/common';
import {
  type createInputFieldSchema,
  type createProductSchema,
  DEFAULT_MAX_QUANTITY,
  type ImportRowError,
  type InputField,
  inputFieldShapeSchema,
  MAX_INPUT_FIELDS_PER_GAME,
  MAX_PRODUCTS_PER_GAME,
  type Product,
  type ProductKind,
  type UpdateInputField,
  type UpdateProduct,
} from '@vertex-digital/contracts';
import {
  catalogInputFields,
  catalogProducts,
  type Database,
  newId,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { CatalogService } from './catalog.service.js';
import {
  type Actor,
  assertComplete,
  auditCatalog,
  changes,
  checkReorder,
  type FieldRow,
  type GameRow,
  isUuid,
  mapTaken,
  nextSortOrder,
  type ProductRow,
  refusals,
  rewriteOrder,
  toInputField,
} from './catalog-records.js';

const fieldValues = (row: FieldRow) => ({
  identifier: row.key,
  labelAr: row.labelAr,
  helpAr: row.helpAr,
  type: row.type,
  required: row.required,
  minLength: row.minLength,
  maxLength: row.maxLength,
  options: row.options,
});

const productValues = (row: ProductRow) => ({
  kind: row.kind,
  nameAr: row.nameAr,
  gameAmount: row.gameAmount,
  officialPriceUsdUnits: row.officialPriceUsdUnits,
  maxQuantity: row.maxQuantity,
  regionAr: row.regionAr,
  redemptionAr: row.redemptionAr,
  status: row.status,
});

const fieldEntity = (id: string) => ({ type: 'catalog_input_field' as const, id });
const productEntity = (id: string) => ({ type: 'catalog_product' as const, id });
const gameEntity = (id: string) => ({ type: 'catalog_game' as const, id });

/**
 * A game's input fields and products (S06 rules CT1, CT3, CT5, CT7, CT8). Every change locks the
 * game first (`CatalogService.lockGame`), so limits, orders and rule CT3 hold under parallel
 * changes.
 */
@Injectable()
export class CatalogItemsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly catalog: CatalogService,
  ) {}

  // Input fields (rule CT7) ------------------------------------------------------------------------

  createField(
    actor: Actor,
    gameId: string,
    input: z.output<typeof createInputFieldSchema>,
  ): Promise<InputField> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const game = await this.liveGame(tx, gameId);
        await this.checkLimit(tx, catalogInputFields, game.id, MAX_INPUT_FIELDS_PER_GAME);
        const [row] = await tx
          .insert(catalogInputFields)
          .values({
            id: newId(),
            gameId: game.id,
            key: input.key,
            labelAr: input.labelAr,
            helpAr: input.helpAr ?? null,
            type: input.type,
            required: input.required,
            minLength: input.minLength,
            maxLength: input.maxLength,
            options: input.options,
            sortOrder: await nextSortOrder(
              tx,
              catalogInputFields,
              eq(catalogInputFields.gameId, game.id),
            ),
          })
          .returning();
        const field = row as FieldRow;
        await auditCatalog(tx, actor, 'catalog_input_field.created', fieldEntity(field.id), {
          gameId: game.id,
          ...fieldValues(field),
        });
        return toInputField(field);
      }),
    );
  }

  /**
   * Everything but the key and the type (rule CT7), checked again against the stored type. Making
   * the last required field optional is refused while the game is active (rule CT3).
   */
  updateField(actor: Actor, id: string, input: UpdateInputField): Promise<InputField> {
    return this.db.transaction(async (tx) => {
      const { game, row: before } = await this.lockField(tx, id);
      const shape = inputFieldShapeSchema.safeParse({
        type: before.type,
        minLength: input.minLength === undefined ? before.minLength : input.minLength,
        maxLength: input.maxLength === undefined ? before.maxLength : input.maxLength,
        options: input.options === undefined ? before.options : input.options,
      });
      if (!shape.success) throw refusals.invalid('The bounds or options do not fit the field type');
      const next = {
        labelAr: input.labelAr ?? before.labelAr,
        helpAr: input.helpAr === undefined ? before.helpAr : input.helpAr,
        required: input.required ?? before.required,
        minLength: shape.data.minLength,
        maxLength: shape.data.maxLength,
        options: shape.data.options,
      };
      const current = fieldValues(before);
      const changed = changes(current, next);
      if (!changed) return toInputField(before);
      const [row] = await tx
        .update(catalogInputFields)
        .set(next)
        .where(eq(catalogInputFields.id, id))
        .returning();
      if (!before.archivedAt) await assertComplete(tx, game);
      await auditCatalog(tx, actor, 'catalog_input_field.updated', fieldEntity(id), changed);
      return toInputField(row as FieldRow);
    });
  }

  reorderFields(actor: Actor, gameId: string, ids: string[]): Promise<InputField[]> {
    return this.db.transaction(async (tx) => {
      const game = await this.catalog.lockGame(tx, gameId);
      await this.reorder(tx, catalogInputFields, game.id, ids);
      await auditCatalog(tx, actor, 'catalog_input_field.reordered', gameEntity(game.id), {
        gameId: game.id,
        ids,
      });
      const rows = await tx
        .select()
        .from(catalogInputFields)
        .where(and(eq(catalogInputFields.gameId, game.id), isNull(catalogInputFields.archivedAt)))
        .orderBy(asc(catalogInputFields.sortOrder));
      return rows.map(toInputField);
    });
  }

  /** Archiving the last required field of an active game with direct products is refused (CT3). */
  archiveField(actor: Actor, id: string): Promise<InputField> {
    return this.db.transaction(async (tx) => {
      const { game, row } = await this.lockField(tx, id);
      if (row.archivedAt) return toInputField(row);
      const [archived] = await tx
        .update(catalogInputFields)
        .set({ archivedAt: new Date() })
        .where(eq(catalogInputFields.id, id))
        .returning();
      await assertComplete(tx, game);
      await auditCatalog(tx, actor, 'catalog_input_field.archived', fieldEntity(id), {
        gameId: game.id,
        identifier: row.key,
      });
      return toInputField(archived as FieldRow);
    });
  }

  restoreField(actor: Actor, id: string): Promise<InputField> {
    return this.db.transaction(async (tx) => {
      const { game, row } = await this.lockField(tx, id);
      if (!row.archivedAt) return toInputField(row);
      if (game.archivedAt) throw refusals.parentArchived();
      await this.checkLimit(tx, catalogInputFields, game.id, MAX_INPUT_FIELDS_PER_GAME);
      const [restored] = await tx
        .update(catalogInputFields)
        .set({
          archivedAt: null,
          sortOrder: await nextSortOrder(
            tx,
            catalogInputFields,
            eq(catalogInputFields.gameId, game.id),
          ),
        })
        .where(eq(catalogInputFields.id, id))
        .returning();
      await auditCatalog(tx, actor, 'catalog_input_field.restored', fieldEntity(id), {
        gameId: game.id,
        identifier: row.key,
      });
      return toInputField(restored as FieldRow);
    });
  }

  // Products (rule CT8) ----------------------------------------------------------------------------

  /** A `direct` product in an active game needs a required field first (rule CT3). */
  createProduct(
    actor: Actor,
    gameId: string,
    input: z.output<typeof createProductSchema>,
  ): Promise<Product> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const game = await this.liveGame(tx, gameId);
        await this.checkLimit(tx, catalogProducts, game.id, MAX_PRODUCTS_PER_GAME);
        const [row] = await tx
          .insert(catalogProducts)
          .values({
            id: newId(),
            gameId: game.id,
            kind: input.kind,
            nameAr: input.nameAr,
            gameAmount: input.gameAmount ?? null,
            officialPriceUsdUnits: input.officialPriceUsdUnits ?? null,
            maxQuantity: input.maxQuantity,
            regionAr: input.kind === 'code' ? (input.regionAr ?? null) : null,
            redemptionAr: input.kind === 'code' ? (input.redemptionAr ?? null) : null,
            sortOrder: await nextSortOrder(
              tx,
              catalogProducts,
              eq(catalogProducts.gameId, game.id),
            ),
          })
          .returning();
        const product = row as ProductRow;
        await assertComplete(tx, game);
        await auditCatalog(tx, actor, 'catalog_product.created', productEntity(product.id), {
          gameId: game.id,
          ...productValues(product),
        });
        return this.product(tx, product);
      }),
    );
  }

  /** Everything but the kind; region and redemption text only on a `code` product (rule CT8). */
  updateProduct(actor: Actor, id: string, input: UpdateProduct): Promise<Product> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const { row: before } = await this.lockProduct(tx, id);
        const codeOnly = [input.regionAr, input.redemptionAr].some(
          (value) => value !== undefined && value !== null,
        );
        if (before.kind === 'direct' && codeOnly) {
          throw refusals.invalid('Region and redemption text are for code products only');
        }
        const current = productValues(before);
        const changed = changes(current, input);
        let row = before;
        if (changed) {
          const [updated] = await tx
            .update(catalogProducts)
            .set(changed.after)
            .where(eq(catalogProducts.id, id))
            .returning();
          row = updated as ProductRow;
          await auditCatalog(tx, actor, 'catalog_product.updated', productEntity(id), changed);
        }
        return this.product(tx, row);
      }),
    );
  }

  reorderProducts(actor: Actor, gameId: string, ids: string[]): Promise<Product[]> {
    return this.db.transaction(async (tx) => {
      const game = await this.catalog.lockGame(tx, gameId);
      await this.reorder(tx, catalogProducts, game.id, ids);
      await auditCatalog(tx, actor, 'catalog_product.reordered', gameEntity(game.id), {
        gameId: game.id,
        ids,
      });
      const rows = await tx
        .select()
        .from(catalogProducts)
        .where(and(eq(catalogProducts.gameId, game.id), isNull(catalogProducts.archivedAt)))
        .orderBy(asc(catalogProducts.sortOrder));
      return this.catalog.products(tx, rows);
    });
  }

  archiveProduct(actor: Actor, id: string): Promise<Product> {
    return this.db.transaction(async (tx) => {
      const { game, row } = await this.lockProduct(tx, id);
      let result = row;
      if (!row.archivedAt) {
        const [archived] = await tx
          .update(catalogProducts)
          .set({ archivedAt: new Date() })
          .where(eq(catalogProducts.id, id))
          .returning();
        result = archived as ProductRow;
        await auditCatalog(tx, actor, 'catalog_product.archived', productEntity(id), {
          gameId: game.id,
          nameAr: row.nameAr,
        });
      }
      return this.product(tx, result);
    });
  }

  /** Rule CT1, CT3: refused under an archived game, beyond 100, or into an incomplete active game. */
  restoreProduct(actor: Actor, id: string): Promise<Product> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const { game, row } = await this.lockProduct(tx, id);
        let result = row;
        if (row.archivedAt) {
          if (game.archivedAt) throw refusals.parentArchived();
          await this.checkLimit(tx, catalogProducts, game.id, MAX_PRODUCTS_PER_GAME);
          const [restored] = await tx
            .update(catalogProducts)
            .set({
              archivedAt: null,
              sortOrder: await nextSortOrder(
                tx,
                catalogProducts,
                eq(catalogProducts.gameId, game.id),
              ),
            })
            .where(eq(catalogProducts.id, id))
            .returning();
          result = restored as ProductRow;
          await assertComplete(tx, game);
          await auditCatalog(tx, actor, 'catalog_product.restored', productEntity(id), {
            gameId: game.id,
            nameAr: row.nameAr,
          });
        }
        return this.product(tx, result);
      }),
    );
  }

  // For the `pricing` and `suppliers` modules (S07) -----------------------------------------------

  /**
   * The product and its game, the game locked first (S06 lock order): a pricing decision or a
   * route change holds it before the repricing write path locks the product.
   */
  async lockProduct(tx: Transaction, id: string): Promise<{ game: GameRow; row: ProductRow }> {
    const gameId = await this.parentOf(tx, catalogProducts, id, 'product');
    const game = await this.catalog.lockGame(tx, gameId);
    const [row] = await tx.select().from(catalogProducts).where(eq(catalogProducts.id, id));
    return { game, row: row as ProductRow };
  }

  /** A review's pause (S07 rule P4, CT4) in the caller's transaction, with its audit entry. */
  async pauseProductIn(tx: Transaction, actor: Actor, id: string): Promise<void> {
    const { row } = await this.lockProduct(tx, id);
    if (row.status === 'paused') return;
    await tx.update(catalogProducts).set({ status: 'paused' }).where(eq(catalogProducts.id, id));
    await auditCatalog(tx, actor, 'catalog_product.updated', productEntity(id), {
      before: { status: row.status },
      after: { status: 'paused' },
    });
  }

  /**
   * An import's products (S07 rule RT8) in the caller's transaction: created `paused` with the
   * defaults of S06, last in the game, each with its audit entry. All or nothing: every refused
   * row is listed in `details.rows` (`NAME_TAKEN`, `CATALOG_LIMIT_REACHED`); an archived game is
   * `PARENT_ARCHIVED`.
   */
  async importProductsIn(
    tx: Transaction,
    actor: Actor,
    gameId: string,
    rows: readonly { nameAr: string; kind: ProductKind }[],
  ): Promise<ProductRow[]> {
    const game = await this.liveGame(tx, gameId);
    const live = await tx
      .select({ nameAr: catalogProducts.nameAr })
      .from(catalogProducts)
      .where(and(eq(catalogProducts.gameId, game.id), isNull(catalogProducts.archivedAt)));
    const taken = new Set(live.map((row) => row.nameAr));
    const errors: (ImportRowError & { code: 'NAME_TAKEN' | 'CATALOG_LIMIT_REACHED' })[] = [];
    rows.forEach((row, index) => {
      if (taken.has(row.nameAr)) errors.push({ index, code: 'NAME_TAKEN' });
      else if (live.length + index >= MAX_PRODUCTS_PER_GAME) {
        errors.push({ index, code: 'CATALOG_LIMIT_REACHED' });
      }
      taken.add(row.nameAr);
    });
    const [first] = errors;
    if (first) {
      throw new CodedException(409, first.code, 'Some rows cannot be imported', {
        rows: errors,
      });
    }
    let sortOrder = await nextSortOrder(tx, catalogProducts, eq(catalogProducts.gameId, game.id));
    const created = await tx
      .insert(catalogProducts)
      .values(
        rows.map((row) => ({
          id: newId(),
          gameId: game.id,
          kind: row.kind,
          nameAr: row.nameAr,
          maxQuantity: DEFAULT_MAX_QUANTITY[row.kind],
          status: 'paused' as const,
          sortOrder: sortOrder++,
        })),
      )
      .returning();
    await assertComplete(tx, game);
    for (const product of created) {
      await auditCatalog(tx, actor, 'catalog_product.created', productEntity(product.id), {
        gameId: game.id,
        ...productValues(product),
      });
    }
    return created;
  }

  // Helpers ---------------------------------------------------------------------------------------

  private async product(tx: Transaction, row: ProductRow): Promise<Product> {
    const [product] = await this.catalog.products(tx, [row]);
    return product as Product;
  }

  /** A game that can take a new field or product: it exists and is not archived. */
  private async liveGame(tx: Transaction, gameId: string): Promise<GameRow> {
    const game = await this.catalog.lockGame(tx, gameId);
    if (game.archivedAt) throw refusals.parentArchived();
    return game;
  }

  /** The field and its game, the game locked first. */
  private async lockField(tx: Transaction, id: string) {
    const gameId = await this.parentOf(tx, catalogInputFields, id, 'input field');
    const game = await this.catalog.lockGame(tx, gameId);
    const [row] = await tx.select().from(catalogInputFields).where(eq(catalogInputFields.id, id));
    return { game, row: row as FieldRow };
  }

  private async parentOf(
    tx: Transaction,
    table: typeof catalogInputFields | typeof catalogProducts,
    id: string,
    what: string,
  ): Promise<string> {
    const [row] = isUuid(id)
      ? await tx.select({ gameId: table.gameId }).from(table).where(eq(table.id, id))
      : [];
    if (!row) throw refusals.notFound(what);
    return row.gameId;
  }

  private async checkLimit(
    tx: Transaction,
    table: typeof catalogInputFields | typeof catalogProducts,
    gameId: string,
    limit: number,
  ): Promise<void> {
    const [row] = await tx
      .select({ total: count() })
      .from(table)
      .where(and(eq(table.gameId, gameId), isNull(table.archivedAt)));
    if ((row?.total ?? 0) >= limit) throw refusals.limit(limit);
  }

  private async reorder(
    tx: Transaction,
    table: typeof catalogInputFields | typeof catalogProducts,
    gameId: string,
    ids: string[],
  ): Promise<void> {
    const current = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.gameId, gameId), isNull(table.archivedAt)));
    checkReorder(
      current.map((row) => row.id),
      ids,
    );
    await rewriteOrder(tx, table, ids);
  }
}
