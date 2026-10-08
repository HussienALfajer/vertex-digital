import { Inject, Injectable } from '@nestjs/common';
import {
  ACCENT_DARK_SURFACE,
  ACCENT_MIN_CONTRAST,
  type CatalogImage,
  type Category,
  type CategoryListQuery,
  type CreateCategory,
  type CreateGame,
  contrastRatio,
  type Game,
  type GameDetail,
  type GameListQuery,
  type GamePage,
  type MarginScope,
  type UpdateCategory,
  type UpdateGame,
} from '@vertex-digital/contracts';
import {
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  type Database,
  newId,
  type Transaction,
} from '@vertex-digital/db';
import {
  and,
  asc,
  type Column,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import {
  type Actor,
  assertComplete,
  auditCatalog,
  type CategoryRow,
  changes,
  checkReorder,
  containing,
  type GameRow,
  isUuid,
  mapTaken,
  nextSortOrder,
  refusals,
  rewriteOrder,
  toCategory,
  toImage,
  toInputField,
  toProduct,
} from './catalog-records.js';

/** The categories' order has no parent row to lock: a transaction-level advisory lock instead. */
const CATEGORY_ORDER_KEY = sql`hashtext('catalog_categories_order')`;

/** Unarchived games in a category (rule CT2). */
const gameCount = sql<number>`(select count(*)::int from ${catalogGames}
  where ${catalogGames.categoryId} = ${catalogCategories.id} and ${catalogGames.archivedAt} is null)`;

/** Unarchived products of a game. */
const productCount = sql<number>`(select count(*)::int from ${catalogProducts}
  where ${catalogProducts.gameId} = ${catalogGames.id} and ${catalogProducts.archivedAt} is null)`;

type GameValues = Pick<
  GameRow,
  | 'categoryId'
  | 'slug'
  | 'nameAr'
  | 'nameEn'
  | 'status'
  | 'coverFileId'
  | 'idGuideFileId'
  | 'accentColor'
  | 'regionNotesAr'
>;

const gameValues = (row: GameValues): GameValues => ({
  categoryId: row.categoryId,
  slug: row.slug,
  nameAr: row.nameAr,
  nameEn: row.nameEn,
  status: row.status,
  coverFileId: row.coverFileId,
  idGuideFileId: row.idGuideFileId,
  accentColor: row.accentColor,
  regionNotesAr: row.regionNotesAr,
});

/** A catalog target of a margin rule, as the `pricing` module sees it. */
export interface PricingTarget {
  nameAr: string;
  /** The target, or a row above it, is archived. */
  archived: boolean;
  path: { productId?: string; gameId?: string; categoryId?: string };
  /** A product's official price (rule PR7); null otherwise. */
  officialPriceUsdUnits: number | null;
}

/**
 * The catalog (S06, F08): categories, games and their images, rules CT1–CT6 and CT10; the
 * fields and products of a game are in `CatalogItemsService`. The only writer of the catalog
 * tables. Locks go category, then game, everywhere, so no two changes deadlock.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly files: FilesService,
  ) {}

  // Images (rule CT10) ----------------------------------------------------------------------------

  /** Not audited by itself: the game change that uses the image is. */
  async uploadImage(upload: Buffer | undefined): Promise<CatalogImage> {
    const prepared = await this.files.prepare('catalog_image', upload);
    await this.db.transaction((tx) => this.files.record(tx, prepared));
    return toImage(prepared.row.id, {
      width: prepared.row.width as number,
      height: prepared.row.height as number,
    });
  }

  /** The public image route: catalog images only, never receipts or QR images. */
  async image(id: string): Promise<ServedFile> {
    const file = isUuid(id) ? await this.files.serve(id, 'catalog_image') : null;
    if (!file) throw refusals.notFound('catalog image');
    return file;
  }

  // Categories ------------------------------------------------------------------------------------

  async categories(query: CategoryListQuery, executor: Database | Transaction = this.db) {
    const rows = await executor
      .select({ row: catalogCategories, gameCount })
      .from(catalogCategories)
      .where(archivedFilter(catalogCategories.archivedAt, query.archived))
      .orderBy(asc(catalogCategories.sortOrder), asc(catalogCategories.createdAt));
    return rows.map(({ row, gameCount }) => toCategory(row, gameCount));
  }

  createCategory(actor: Actor, input: CreateCategory & { slug: string }): Promise<Category> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${CATEGORY_ORDER_KEY})`);
        const [row] = await tx
          .insert(catalogCategories)
          .values({
            id: newId(),
            slug: input.slug,
            nameAr: input.nameAr,
            sortOrder: await nextSortOrder(tx, catalogCategories, undefined),
          })
          .returning();
        const created = row as CategoryRow;
        await auditCatalog(tx, actor, 'catalog_category.created', categoryEntity(created.id), {
          slug: created.slug,
          nameAr: created.nameAr,
        });
        return toCategory(created, 0);
      }),
    );
  }

  updateCategory(actor: Actor, id: string, input: UpdateCategory): Promise<Category> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const before = await this.lockCategory(tx, id);
        const changed = changes({ nameAr: before.nameAr }, { nameAr: input.nameAr });
        if (changed) {
          await tx
            .update(catalogCategories)
            .set({ nameAr: input.nameAr })
            .where(eq(catalogCategories.id, id));
          await auditCatalog(tx, actor, 'catalog_category.updated', categoryEntity(id), changed);
        }
        return this.category(tx, id);
      }),
    );
  }

  /** Rule CT5: the full list of unarchived categories, in their new order. */
  reorderCategories(actor: Actor, ids: string[]): Promise<Category[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CATEGORY_ORDER_KEY})`);
      const current = await tx
        .select({ id: catalogCategories.id })
        .from(catalogCategories)
        .where(isNull(catalogCategories.archivedAt));
      checkReorder(
        current.map((row) => row.id),
        ids,
      );
      await rewriteOrder(tx, catalogCategories, ids);
      await auditCatalog(
        tx,
        actor,
        'catalog_category.reordered',
        categoryEntity(ids[0] as string),
        {
          ids,
        },
      );
      return this.categories({}, tx);
    });
  }

  /** Rule CT2: refused while the category holds unarchived games, which `details` names. */
  archiveCategory(actor: Actor, id: string): Promise<Category> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockCategory(tx, id);
      if (row.archivedAt) return this.category(tx, id);
      const games = await tx
        .select({ id: catalogGames.id, nameAr: catalogGames.nameAr })
        .from(catalogGames)
        .where(and(eq(catalogGames.categoryId, id), isNull(catalogGames.archivedAt)))
        .orderBy(asc(catalogGames.sortOrder));
      if (games.length > 0) {
        throw new CodedException(409, 'CATALOG_NOT_EMPTY', 'The category has unarchived games', {
          games,
        });
      }
      await tx
        .update(catalogCategories)
        .set({ archivedAt: new Date() })
        .where(eq(catalogCategories.id, id));
      await auditCatalog(tx, actor, 'catalog_category.archived', categoryEntity(id), {
        nameAr: row.nameAr,
      });
      return this.category(tx, id);
    });
  }

  /** Rule CT1: back as it was, last in the order; `NAME_TAKEN` if a live category has its name. */
  restoreCategory(actor: Actor, id: string): Promise<Category> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${CATEGORY_ORDER_KEY})`);
        const row = await this.lockCategory(tx, id);
        if (!row.archivedAt) return this.category(tx, id);
        await tx
          .update(catalogCategories)
          .set({
            archivedAt: null,
            sortOrder: await nextSortOrder(tx, catalogCategories, undefined),
          })
          .where(eq(catalogCategories.id, id));
        await auditCatalog(tx, actor, 'catalog_category.restored', categoryEntity(id), {
          nameAr: row.nameAr,
        });
        return this.category(tx, id);
      }),
    );
  }

  // Games -----------------------------------------------------------------------------------------

  async games(query: GameListQuery): Promise<GamePage> {
    const where = and(
      query.categoryId ? eq(catalogGames.categoryId, query.categoryId) : undefined,
      query.status ? eq(catalogGames.status, query.status) : undefined,
      archivedFilter(catalogGames.archivedAt, query.archived),
      query.q
        ? or(
            ilike(catalogGames.nameAr, containing(query.q)),
            ilike(catalogGames.nameEn, containing(query.q)),
            ilike(catalogGames.slug, containing(query.q)),
          )
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ row: catalogGames, productCount })
        .from(catalogGames)
        .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
        .where(where)
        .orderBy(
          asc(catalogCategories.sortOrder),
          asc(catalogGames.sortOrder),
          asc(catalogGames.createdAt),
        )
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(catalogGames).where(where),
    ]);
    const images = await this.images(rows.map(({ row }) => row));
    return {
      items: rows.map(({ row, productCount }) => toGame(row, images, productCount)),
      total: total?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** A game with every field and product, archived ones included. */
  async game(id: string, executor: Database | Transaction = this.db): Promise<GameDetail> {
    const [found] = isUuid(id)
      ? await executor
          .select({ row: catalogGames, categoryArchivedAt: catalogCategories.archivedAt })
          .from(catalogGames)
          .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
          .where(eq(catalogGames.id, id))
      : [];
    if (!found) throw refusals.notFound('game');
    const { row } = found;
    const [fields, products, images] = await Promise.all([
      executor
        .select()
        .from(catalogInputFields)
        .where(eq(catalogInputFields.gameId, id))
        .orderBy(
          sql`${catalogInputFields.archivedAt} is not null`,
          asc(catalogInputFields.sortOrder),
        ),
      executor
        .select()
        .from(catalogProducts)
        .where(eq(catalogProducts.gameId, id))
        .orderBy(sql`${catalogProducts.archivedAt} is not null`, asc(catalogProducts.sortOrder)),
      this.images([row]),
    ]);
    const facts = {
      categoryArchived: found.categoryArchivedAt !== null,
      gameArchived: row.archivedAt !== null,
      gameStatus: row.status,
    };
    return {
      ...toGame(row, images, products.filter((product) => !product.archivedAt).length),
      categoryArchived: facts.categoryArchived,
      fields: fields.map(toInputField),
      products: products.map((product) => toProduct(product, facts)),
    };
  }

  /** A new game starts paused, last in its category (rules CT3, CT5). */
  createGame(actor: Actor, input: CreateGame & { slug: string }): Promise<GameDetail> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        await this.lockLiveCategory(tx, input.categoryId);
        const values = {
          categoryId: input.categoryId,
          slug: input.slug,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          status: 'paused' as const,
          coverFileId: input.coverFileId ?? null,
          idGuideFileId: input.idGuideFileId ?? null,
          accentColor: input.accentColor ?? null,
          regionNotesAr: input.regionNotesAr ?? null,
        };
        await this.checkImages(values);
        checkAccent(values.accentColor);
        const id = newId();
        await tx.insert(catalogGames).values({
          id,
          ...values,
          sortOrder: await nextSortOrder(
            tx,
            catalogGames,
            eq(catalogGames.categoryId, values.categoryId),
          ),
        });
        await auditCatalog(tx, actor, 'catalog_game.created', gameEntity(id), values);
        return this.game(id, tx);
      }),
    );
  }

  /**
   * Everything but the slug (rule CT1). A move goes to the end of another live category (rule
   * CT2); `active`, or removing the cover of an active game, needs a complete game (rule CT3).
   */
  updateGame(actor: Actor, id: string, input: UpdateGame): Promise<GameDetail> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const current = await this.findGame(tx, id);
        const moving = input.categoryId !== undefined && input.categoryId !== current.categoryId;
        if (moving) await this.lockLiveCategory(tx, input.categoryId as string);
        const before = await this.lockGame(tx, id);
        const after: GameValues = {
          ...gameValues(before),
          ...definedOnly({
            categoryId: input.categoryId,
            nameAr: input.nameAr,
            nameEn: input.nameEn,
            status: input.status,
            coverFileId: input.coverFileId,
            idGuideFileId: input.idGuideFileId,
            accentColor: input.accentColor,
            regionNotesAr: input.regionNotesAr,
          }),
        };
        const changed = changes(gameValues(before), after);
        if (!changed) return this.game(id, tx);
        await this.checkImages(changed.after);
        if (changed.after.accentColor !== undefined) checkAccent(after.accentColor);
        await tx
          .update(catalogGames)
          .set({
            ...changed.after,
            ...(moving && {
              sortOrder: await nextSortOrder(
                tx,
                catalogGames,
                eq(catalogGames.categoryId, after.categoryId),
              ),
            }),
          })
          .where(eq(catalogGames.id, id));
        await assertComplete(tx, { id, status: after.status, coverFileId: after.coverFileId });
        await auditCatalog(tx, actor, 'catalog_game.updated', gameEntity(id), changed);
        return this.game(id, tx);
      }),
    );
  }

  /** Rule CT5: the full list of unarchived games of the category, in their new order. */
  reorderGames(actor: Actor, categoryId: string, ids: string[]): Promise<Game[]> {
    return this.db.transaction(async (tx) => {
      await this.lockCategory(tx, categoryId);
      const current = await tx
        .select({ id: catalogGames.id })
        .from(catalogGames)
        .where(and(eq(catalogGames.categoryId, categoryId), isNull(catalogGames.archivedAt)));
      checkReorder(
        current.map((row) => row.id),
        ids,
      );
      await rewriteOrder(tx, catalogGames, ids);
      await auditCatalog(tx, actor, 'catalog_game.reordered', categoryEntity(categoryId), {
        categoryId,
        ids,
      });
      const rows = await tx
        .select({ row: catalogGames, productCount })
        .from(catalogGames)
        .where(and(eq(catalogGames.categoryId, categoryId), isNull(catalogGames.archivedAt)))
        .orderBy(asc(catalogGames.sortOrder));
      const images = await this.images(rows.map(({ row }) => row));
      return rows.map(({ row, productCount }) => toGame(row, images, productCount));
    });
  }

  archiveGame(actor: Actor, id: string): Promise<GameDetail> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockGame(tx, id);
      if (!row.archivedAt) {
        await tx
          .update(catalogGames)
          .set({ archivedAt: new Date() })
          .where(eq(catalogGames.id, id));
        await auditCatalog(tx, actor, 'catalog_game.archived', gameEntity(id), {
          nameAr: row.nameAr,
        });
      }
      return this.game(id, tx);
    });
  }

  /** Rule CT1: refused under an archived category; back last in its category. */
  restoreGame(actor: Actor, id: string): Promise<GameDetail> {
    return mapTaken(() =>
      this.db.transaction(async (tx) => {
        const current = await this.findGame(tx, id);
        const category = await this.lockCategory(tx, current.categoryId);
        if (category.archivedAt) throw refusals.parentArchived();
        const row = await this.lockGame(tx, id);
        if (row.archivedAt) {
          await tx
            .update(catalogGames)
            .set({
              archivedAt: null,
              sortOrder: await nextSortOrder(
                tx,
                catalogGames,
                eq(catalogGames.categoryId, row.categoryId),
              ),
            })
            .where(eq(catalogGames.id, id));
          await auditCatalog(tx, actor, 'catalog_game.restored', gameEntity(id), {
            nameAr: row.nameAr,
          });
        }
        return this.game(id, tx);
      }),
    );
  }

  // For the game's fields and products (`CatalogItemsService`) --------------------------------------

  /** Locks a game for a change to its fields or products; `NOT_FOUND` when there is none. */
  async lockGame(tx: Transaction, id: string): Promise<GameRow> {
    const [row] = isUuid(id)
      ? await tx.select().from(catalogGames).where(eq(catalogGames.id, id)).for('update')
      : [];
    if (!row) throw refusals.notFound('game');
    return row;
  }

  /** The facts a product's availability needs (rule CT9), under the game lock. */
  async gameFacts(tx: Transaction, game: GameRow) {
    const [category] = await tx
      .select({ archivedAt: catalogCategories.archivedAt })
      .from(catalogCategories)
      .where(eq(catalogCategories.id, game.categoryId));
    return {
      categoryArchived: Boolean(category?.archivedAt),
      gameArchived: game.archivedAt !== null,
      gameStatus: game.status,
    };
  }

  // For the `pricing` module ---------------------------------------------------------------------

  /** A margin rule's target with its path (rule PR2), or null when it does not exist. */
  async pricingTarget(
    scope: Exclude<MarginScope, 'global'>,
    id: string,
  ): Promise<PricingTarget | null> {
    if (!isUuid(id)) return null;
    if (scope === 'category') {
      const [row] = await this.db
        .select()
        .from(catalogCategories)
        .where(eq(catalogCategories.id, id));
      return row
        ? {
            nameAr: row.nameAr,
            archived: row.archivedAt !== null,
            path: { categoryId: row.id },
            officialPriceUsdUnits: null,
          }
        : null;
    }
    if (scope === 'game') {
      const [row] = await this.db
        .select({ game: catalogGames, categoryArchivedAt: catalogCategories.archivedAt })
        .from(catalogGames)
        .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
        .where(eq(catalogGames.id, id));
      return row
        ? {
            nameAr: row.game.nameAr,
            archived: row.game.archivedAt !== null || row.categoryArchivedAt !== null,
            path: { gameId: row.game.id, categoryId: row.game.categoryId },
            officialPriceUsdUnits: null,
          }
        : null;
    }
    const [row] = await this.db
      .select({
        product: catalogProducts,
        categoryId: catalogGames.categoryId,
        gameArchivedAt: catalogGames.archivedAt,
        categoryArchivedAt: catalogCategories.archivedAt,
      })
      .from(catalogProducts)
      .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
      .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
      .where(eq(catalogProducts.id, id));
    return row
      ? {
          nameAr: row.product.nameAr,
          archived:
            row.product.archivedAt !== null ||
            row.gameArchivedAt !== null ||
            row.categoryArchivedAt !== null,
          path: {
            productId: row.product.id,
            gameId: row.product.gameId,
            categoryId: row.categoryId,
          },
          officialPriceUsdUnits: row.product.officialPriceUsdUnits,
        }
      : null;
  }

  /** Each target's name and whether it is archived, keyed by id (`GET /api/admin/pricing/rules`). */
  async pricingTargetNames(
    ids: readonly string[],
  ): Promise<Map<string, { nameAr: string; archived: boolean }>> {
    if (ids.length === 0) return new Map();
    const list = [...ids];
    const [categories, games, products] = await Promise.all([
      this.db
        .select({
          id: catalogCategories.id,
          nameAr: catalogCategories.nameAr,
          archivedAt: catalogCategories.archivedAt,
        })
        .from(catalogCategories)
        .where(inArray(catalogCategories.id, list)),
      this.db
        .select({
          id: catalogGames.id,
          nameAr: catalogGames.nameAr,
          archivedAt: catalogGames.archivedAt,
        })
        .from(catalogGames)
        .where(inArray(catalogGames.id, list)),
      this.db
        .select({
          id: catalogProducts.id,
          nameAr: catalogProducts.nameAr,
          archivedAt: catalogProducts.archivedAt,
        })
        .from(catalogProducts)
        .where(inArray(catalogProducts.id, list)),
    ]);
    return new Map(
      [...categories, ...games, ...products].map((row) => [
        row.id,
        { nameAr: row.nameAr, archived: row.archivedAt !== null },
      ]),
    );
  }

  /** The path of every product a customer can see (product, game and category unarchived). */
  livePricingPaths(): Promise<{ productId: string; gameId: string; categoryId: string }[]> {
    return this.db
      .select({
        productId: catalogProducts.id,
        gameId: catalogProducts.gameId,
        categoryId: catalogGames.categoryId,
      })
      .from(catalogProducts)
      .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
      .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
      .where(
        and(
          isNull(catalogProducts.archivedAt),
          isNull(catalogGames.archivedAt),
          isNull(catalogCategories.archivedAt),
        ),
      );
  }

  // Helpers ---------------------------------------------------------------------------------------

  private async category(executor: Database | Transaction, id: string): Promise<Category> {
    const [found] = await executor
      .select({ row: catalogCategories, gameCount })
      .from(catalogCategories)
      .where(eq(catalogCategories.id, id));
    if (!found) throw refusals.notFound('category');
    return toCategory(found.row, found.gameCount);
  }

  private async lockCategory(tx: Transaction, id: string): Promise<CategoryRow> {
    const [row] = isUuid(id)
      ? await tx.select().from(catalogCategories).where(eq(catalogCategories.id, id)).for('update')
      : [];
    if (!row) throw refusals.notFound('category');
    return row;
  }

  /** A category a game can join: it exists and is not archived (rule CT2, edge case 4). */
  private async lockLiveCategory(tx: Transaction, id: string): Promise<CategoryRow> {
    const row = await this.lockCategory(tx, id);
    if (row.archivedAt) throw refusals.parentArchived();
    return row;
  }

  private async findGame(tx: Transaction, id: string): Promise<GameRow> {
    const [row] = isUuid(id)
      ? await tx.select().from(catalogGames).where(eq(catalogGames.id, id))
      : [];
    if (!row) throw refusals.notFound('game');
    return row;
  }

  /** The image ids set by a change must be catalog images (`NOT_FOUND` otherwise). */
  private async checkImages(values: Partial<Pick<GameValues, 'coverFileId' | 'idGuideFileId'>>) {
    const ids = [values.coverFileId, values.idGuideFileId].filter(
      (id): id is string => typeof id === 'string',
    );
    const found = await this.files.dimensions(ids, 'catalog_image');
    if (ids.some((id) => !found.has(id))) throw refusals.notFound('catalog image');
  }

  private async images(rows: readonly GameRow[]) {
    const ids = rows.flatMap((row) =>
      [row.coverFileId, row.idGuideFileId].filter((id): id is string => id !== null),
    );
    return this.files.dimensions(ids, 'catalog_image');
  }
}

/** The admin's archive filter (rule CT1): unarchived by default, archived with `true`. */
function archivedFilter(column: Column, archived: 'true' | 'false' | undefined): SQL {
  return archived === 'true' ? isNotNull(column) : isNull(column);
}

/** Rule CT6: at least 3:1 against the dark surface; `details.ratio` is the ratio found. */
function checkAccent(accent: string | null): void {
  if (accent === null) return;
  const ratio = contrastRatio(accent, ACCENT_DARK_SURFACE);
  if (ratio < ACCENT_MIN_CONTRAST) {
    throw new CodedException(400, 'ACCENT_CONTRAST_TOO_LOW', 'The accent is below 3:1 on dark', {
      ratio,
    });
  }
}

function definedOnly<Values extends Record<string, unknown>>(values: Values): Partial<Values> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<Values>;
}

function toGame(
  row: GameRow,
  images: Map<string, { width: number; height: number }>,
  productCount: number,
): Game {
  const image = (id: string | null) => {
    const size = id ? images.get(id) : undefined;
    return id && size ? toImage(id, size) : null;
  };
  return {
    id: row.id,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    categoryId: row.categoryId,
    slug: row.slug,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    status: row.status,
    cover: image(row.coverFileId),
    idGuide: image(row.idGuideFileId),
    accentColor: row.accentColor,
    regionNotesAr: row.regionNotesAr,
    productCount,
  };
}

const categoryEntity = (id: string) => ({ type: 'catalog_category' as const, id });
const gameEntity = (id: string) => ({ type: 'catalog_game' as const, id });
