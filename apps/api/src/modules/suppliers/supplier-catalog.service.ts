import { Inject, Injectable } from '@nestjs/common';
import {
  type CategoryImportResult,
  type CategoryStanding,
  discountPercent,
  type FieldSpec,
  IMPORT_PACK_REFUSALS,
  type ImportDraft,
  type ImportDraftPack,
  type importCategorySchema,
  type linkCategorySchema,
  normalizeSearchText,
  type ProductKind,
  parseGameAmount,
  type SupplierCategoryListQuery,
  type SupplierCategoryNode,
  type SupplierCategoryPage,
  stockLevel,
  suggestInputFields,
  suggestProductName,
  unmappedFields,
} from '@vertex-digital/contracts';
import {
  currentSupplierPolicy,
  type Database,
  newId,
  productRoutes,
  productRoutingStates,
  repriceProducts,
  type SupplierCategoryRow,
  supplierCategories,
  supplierCategoryTree,
  supplierOffers,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { type Actor, CatalogItemsService, CatalogService, mapTaken } from '../catalog/index.js';
import { PricingService } from '../pricing/index.js';
import { SupplierLiveService } from './supplier-live.service.js';
import { auditSuppliers, type OfferRow, refusals, routeTakenRefusal } from './supplier-records.js';

/*
 * The supplier catalog (S16 rules SC4–SC14): the category tree with its states, the import of a
 * node as a new game, its link to an existing game, unlink and ignore. Imports and links write
 * the catalog through `CatalogService` and `CatalogItemsService` in this module's transaction, so
 * a refused row leaves nothing behind (rule SC7).
 */

type ImportInput = z.output<typeof importCategorySchema>;
type LinkInput = z.output<typeof linkCategorySchema>;

/** A row refusal of an import or a link, listed in `details.rows` (S07 rule RT8's shape). */
interface RowError {
  index: number;
  code: string;
  fields?: string[];
  productId?: string;
}

/** The store categories of rule SC14, by the product kind of the node. */
const STORE_CATEGORY_SLUGS: Record<ProductKind, string> = { direct: 'games', code: 'gift-cards' };

const categoryEntity = (id: string) => ({ type: 'supplier_category' as const, id });
const offerEntity = (id: string) => ({ type: 'supplier_offer' as const, id });
const routeEntity = (id: string) => ({ type: 'product_route' as const, id });

/** The node as stored, with its tree around it. */
interface TreeView {
  rows: SupplierCategoryRow[];
  byId: Map<string, SupplierCategoryRow>;
  children: Map<string | null, SupplierCategoryRow[]>;
  standings: Map<string, CategoryStanding>;
}

@Injectable()
export class SupplierCatalogService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly catalog: CatalogService,
    private readonly items: CatalogItemsService,
    private readonly pricing: PricingService,
    private readonly live: SupplierLiveService,
  ) {}

  // The tree (SC4, SC5) -----------------------------------------------------------------------

  /**
   * Rule SC4: a level of the tree (roots without `parentId`), or, with `q` or `state`, every
   * matching node at any depth with its path; `kind` narrows either. By name.
   */
  async categories(code: string, query: SupplierCategoryListQuery): Promise<SupplierCategoryPage> {
    const supplier = await this.live.supplier(code);
    const view = await this.tree(supplier.id);
    const anyDepth = query.q !== undefined || query.state !== undefined;
    const needle = query.q ? normalizeSearchText(query.q) : null;
    const matching = view.rows.filter((row) => {
      if (!anyDepth) {
        const parent = row.parentCategoryId;
        const level =
          query.parentId === undefined
            ? parent === null || !view.byId.has(parent)
            : parent === query.parentId;
        if (!level) return false;
      }
      if (query.kind && row.kind !== query.kind) return false;
      if (query.state && view.standings.get(row.categoryId)?.state !== query.state) return false;
      if (needle && !normalizeSearchText(row.name).includes(needle)) return false;
      return true;
    });
    matching.sort(
      (a, b) => a.name.localeCompare(b.name) || a.categoryId.localeCompare(b.categoryId),
    );
    const start = (query.page - 1) * query.pageSize;
    const page = matching.slice(start, start + query.pageSize);
    return {
      items: await this.nodes(supplier.code, view, page),
      total: matching.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** One node, as the tree shows it; `NOT_FOUND` when the supplier never listed it. */
  async node(code: string, categoryId: string): Promise<SupplierCategoryNode> {
    const supplier = await this.live.supplier(code);
    const view = await this.tree(supplier.id);
    const row = view.byId.get(categoryId);
    if (!row) throw refusals.notFound('category');
    const [node] = await this.nodes(supplier.code, view, [row]);
    return node as SupplierCategoryNode;
  }

  /**
   * The nodes linked to a game itself, across suppliers, as the tree shows them (the game page's
   * "فك الربط" and IM3's cover); `NOT_FOUND` for an unknown game.
   */
  async gameCategories(gameId: string): Promise<SupplierCategoryNode[]> {
    const names = await this.catalog.gameNames([gameId]);
    if (!names.has(gameId)) throw refusals.notFound('game');
    const linked = await this.db
      .selectDistinct({ supplierId: supplierCategories.supplierId })
      .from(supplierCategories)
      .where(eq(supplierCategories.gameId, gameId));
    const nodes: SupplierCategoryNode[] = [];
    for (const { supplierId } of linked) {
      const supplier = await this.live.supplierById(supplierId);
      if (supplier.code === 'fake' && !this.env.SUPPLIER_FAKE_ENABLED) continue;
      const view = await this.tree(supplier.id);
      const rows = view.rows
        .filter((row) => row.gameId === gameId)
        .sort((a, b) => a.name.localeCompare(b.name) || a.categoryId.localeCompare(b.categoryId));
      nodes.push(...(await this.nodes(supplier.code, view, rows)));
    }
    return nodes;
  }

  // Import and link drafts (SC7, SC8, SC12–SC14) -------------------------------------------------

  /**
   * The import dialog's draft, or with `gameId` the link dialog's: the node, its subtree's packs
   * with costs, stock, refusals, suggested names and price previews, the suggested fields and
   * field map, and the suggested game (rules SC12–SC14).
   */
  async draft(code: string, categoryId: string, gameId?: string): Promise<ImportDraft> {
    const supplier = await this.live.supplier(code);
    const view = await this.tree(supplier.id);
    const row = view.byId.get(categoryId);
    if (!row) throw refusals.notFound('category');
    if (row.missingSince) throw categoryMissing();
    const subtree = this.subtree(view, row.categoryId);
    const [offers, policy, linkGame] = await Promise.all([
      this.subtreeOffers(supplier.id, subtree),
      currentSupplierPolicy(this.db),
      gameId ? this.catalog.game(gameId) : Promise.resolve(null),
    ]);
    const mapped = await this.mappedOfferIds(offers.map((offer) => offer.id));
    const kinds = offers.flatMap((offer) => (offer.kind ? [offer.kind] : []));
    const kind = majority(kinds) ?? row.kind;
    const root = this.lineage(view, row.categoryId).at(-1) as SupplierCategoryRow;
    const baseName = root === row ? row.name : `${root.name} ${row.name}`;
    const storeCategoryId = linkGame
      ? linkGame.categoryId
      : await this.catalog.categoryIdBySlug(STORE_CATEGORY_SLUGS[kind ?? 'direct']);
    const usable = offers.filter((offer) => packRefusal(offer, mapped) === null);
    const specs = usable.flatMap((offer) => offer.fieldSpecs ?? []);
    const suggestion = suggestInputFields(specs);
    const specOf = new Map<string, FieldSpec>(specs.map((spec) => [spec.key, spec]));
    const liveFields = (linkGame?.fields ?? []).filter((field) => field.archivedAt === null);
    const fieldMap = linkGame
      ? linkFieldMap(
          suggestion.fieldMap,
          liveFields.map((field) => field.key),
        )
      : suggestion.fieldMap;
    const prices = await this.pricing.pricesFor(
      {
        ...(storeCategoryId && { categoryId: storeCategoryId }),
        ...(linkGame && { gameId: linkGame.id }),
      },
      offers.map((offer) => offer.costUsdUnits),
    );
    const leaves = new Set(offers.map((offer) => offer.categoryId));
    const liveProducts = (linkGame?.products ?? []).filter(
      (product) => product.archivedAt === null,
    );
    const packs: ImportDraftPack[] = offers.map((offer, index) => {
      const leaf = view.byId.get(offer.categoryId as string);
      const packName = offer.name.split(' · ').at(-1) ?? offer.name;
      const amount = parseGameAmount(packName);
      const nameAr = suggestProductName(offer.name, leaf?.name ?? '', leaves.size > 1);
      const match =
        liveProducts.find(
          (product) =>
            (offer.kind === null || product.kind === offer.kind) &&
            ((amount !== null && product.gameAmount === amount) || product.nameAr === nameAr),
        ) ?? null;
      return {
        offerId: offer.id,
        supplierOfferId: offer.offerId,
        name: offer.name,
        leafCategoryId: offer.categoryId as string,
        leafName: leaf?.name ?? '',
        kind: offer.kind,
        costUsdUnits: offer.costUsdUnits,
        originalCostUsdUnits: offer.originalCostUsdUnits,
        discountPercent: discountPercent(offer.costUsdUnits, offer.originalCostUsdUnits),
        stock: offer.stock,
        stockLevel: stockLevel(offer.stock, offer.inStock, policy.lowStockUnits),
        requiredFields: offer.requiredFields,
        refusal: packRefusal(offer, mapped),
        suggestedNameAr: nameAr,
        suggestedGameAmount: amount,
        pricePreviewUsdUnits: prices[index] ?? null,
        match: match && { productId: match.id, nameAr: match.nameAr },
      };
    });
    const [node] = await this.nodes(supplier.code, view, [row]);
    const nameEn = englishName(baseName);
    return {
      category: node as SupplierCategoryNode,
      kind,
      game: {
        nameAr: baseName.slice(0, 60).trim(),
        nameEn,
        slug: await this.freeSlug(nameEn),
        categoryId: storeCategoryId,
      },
      linkGame: linkGame && {
        id: linkGame.id,
        nameAr: linkGame.nameAr,
        fields: liveFields.map((field) => ({ key: field.key, labelAr: field.labelAr })),
      },
      fields: suggestion.fields.map((field) => {
        const spec = specOf.get(field.supplierKey) as FieldSpec;
        return { ...field, supplierLabel: spec.label, supplierType: spec.type };
      }),
      fieldMap,
      packs,
    };
  }

  // Import, link, unlink (SC7–SC9) -------------------------------------------------------------

  /**
   * Rule SC7: the node as a new paused game, with its fields, paused products, enabled routes,
   * first prices (P2) and the node's link, in one transaction. The supplier's image is downloaded
   * and stored before it (IM2). Refused as a whole: `CATEGORY_LINKED`, `CATEGORY_MISSING`, or
   * every refused row in `details.rows`.
   */
  async importCategory(
    actor: Actor,
    code: string,
    categoryId: string,
    input: ImportInput,
  ): Promise<CategoryImportResult> {
    const supplier = await this.live.supplier(code);
    const view = await this.tree(supplier.id);
    const row = this.linkable(view, categoryId, null);
    const fieldKeys = new Set(input.fields.map((field) => field.key));
    if (!Object.values(input.fieldMap).every((key) => fieldKeys.has(key))) {
      throw refusals.invalid('The field map names a field the import does not create');
    }
    const offers = await this.rowOffers(supplier.id, view, row, input.rows);
    const mapped = await this.mappedOfferIds([...offers.values()].map((offer) => offer.id));
    refuseRows(
      input.rows.flatMap((item, index) => {
        const error = rowError(offers.get(item.offerId), mapped, input.fieldMap);
        return error ? [{ index, ...error }] : [];
      }),
    );
    const coverFileId =
      'coverFileId' in input.cover
        ? input.cover.coverFileId
        : (await this.live.storeCover(supplier, row.imageUrl)).id;
    const result = await mapTaken(() =>
      this.db.transaction(async (tx) => {
        const locked = await this.lockNode(tx, supplier.id, row.categoryId, null);
        const gameId = await this.catalog.createGameIn(tx, actor, { ...input.game, coverFileId });
        for (const field of input.fields) {
          await this.items.createFieldIn(tx, actor, gameId, field);
        }
        const products = await this.items.importProductsIn(
          tx,
          actor,
          gameId,
          input.rows.map((item) => ({
            nameAr: item.nameAr,
            kind: kindOf(offers.get(item.offerId) as OfferRow, row),
            gameAmount: item.gameAmount ?? null,
          })),
        );
        const routes = await this.insertRoutes(
          tx,
          actor,
          supplier,
          products.map((product, index) => ({
            productId: product.id,
            offer: offers.get(input.rows[index]?.offerId as string) as OfferRow,
          })),
          input.fieldMap,
        );
        await this.link(tx, actor, locked, gameId);
        await auditSuppliers(tx, actor, 'supplier.category_imported', categoryEntity(locked.id), {
          supplier: supplier.code,
          categoryId: locked.categoryId,
          gameId,
          count: products.length,
        });
        await repriceProducts(tx, {
          productIds: products.map((product) => product.id),
          cause: 'route_change',
          context: routingContext(this.env),
        });
        return {
          gameId,
          products: products.map((product, index) => ({
            id: product.id,
            nameAr: product.nameAr,
            routeId: routes[index] as string,
            existing: false,
          })),
        };
      }),
    ).catch(rethrowRouteTaken);
    return this.withPrices(result);
  }

  /**
   * Rule SC8: the node linked to an existing game, its rows routing existing products of the game
   * or creating new paused ones, in one transaction. Refused when the node, an ancestor or a
   * descendant is linked to another game.
   */
  async linkCategory(
    actor: Actor,
    code: string,
    categoryId: string,
    input: LinkInput,
  ): Promise<CategoryImportResult> {
    const supplier = await this.live.supplier(code);
    const view = await this.tree(supplier.id);
    const row = this.linkable(view, categoryId, input.gameId);
    const game = await this.catalog.game(input.gameId);
    if (game.archivedAt || game.categoryArchived) {
      throw new CodedException(409, 'PARENT_ARCHIVED', 'The game is archived');
    }
    const liveKeys = new Set(
      game.fields.filter((field) => field.archivedAt === null).map((field) => field.key),
    );
    if (!Object.values(input.fieldMap).every((key) => liveKeys.has(key))) {
      throw refusals.invalid('The field map names a field the game does not have');
    }
    const offers = await this.rowOffers(supplier.id, view, row, input.rows);
    const mapped = await this.mappedOfferIds([...offers.values()].map((offer) => offer.id));
    const productOf = new Map(
      game.products.filter((product) => product.archivedAt === null).map((p) => [p.id, p]),
    );
    const routedHere = await this.productsRoutedTo(supplier.id, [...productOf.keys()]);
    refuseRows(
      input.rows.flatMap((item, index) => {
        const offer = offers.get(item.offerId);
        const error = rowError(offer, mapped, input.fieldMap);
        if (error) return [{ index, ...error }];
        if (!('productId' in item)) return [];
        const product = productOf.get(item.productId);
        if (!product) return [{ index, code: 'NOT_FOUND' }];
        if (offer?.kind && offer.kind !== product.kind) {
          return [{ index, code: 'ROUTE_KIND_MISMATCH' }];
        }
        if (routedHere.has(product.id)) return [{ index, code: 'ROUTE_EXISTS' }];
        return [];
      }),
    );
    const result = await mapTaken(() =>
      this.db.transaction(async (tx) => {
        const locked = await this.lockNode(tx, supplier.id, row.categoryId, game.id);
        await this.catalog.lockGame(tx, game.id);
        const fresh = input.rows.flatMap((item, index) =>
          'productId' in item ? [] : [{ item, index }],
        );
        const created =
          fresh.length === 0
            ? []
            : await this.items
                .importProductsIn(
                  tx,
                  actor,
                  game.id,
                  fresh.map(({ item }) => ({
                    nameAr: item.nameAr,
                    kind: kindOf(offers.get(item.offerId) as OfferRow, row),
                    gameAmount: item.gameAmount ?? null,
                  })),
                )
                .catch((error: unknown) => {
                  // The catalog numbers its refused rows among the new ones: back to the request's.
                  throw renumbered(
                    error,
                    fresh.map(({ index }) => index),
                  );
                });
        const createdOf = new Map(fresh.map(({ index }, at) => [index, created[at]]));
        const targets = input.rows.map((item, index) => {
          const productId = 'productId' in item ? item.productId : createdOf.get(index)?.id;
          return { productId: productId as string, offer: offers.get(item.offerId) as OfferRow };
        });
        const routes = await this.insertRoutes(tx, actor, supplier, targets, input.fieldMap);
        if (locked.gameId !== game.id) await this.link(tx, actor, locked, game.id);
        await auditSuppliers(tx, actor, 'supplier_category.linked', categoryEntity(locked.id), {
          supplier: supplier.code,
          categoryId: locked.categoryId,
          gameId: game.id,
          count: input.rows.length,
        });
        await repriceProducts(tx, {
          productIds: targets.map((target) => target.productId),
          cause: 'route_change',
          context: routingContext(this.env),
        });
        return {
          gameId: game.id,
          products: input.rows.map((item, index) => {
            const productId = targets[index]?.productId as string;
            return {
              id: productId,
              nameAr:
                'productId' in item
                  ? (productOf.get(productId)?.nameAr ?? '')
                  : (createdOf.get(index)?.nameAr ?? ''),
              routeId: routes[index] as string,
              existing: 'productId' in item,
            };
          }),
        };
      }),
    ).catch(rethrowRouteTaken);
    return this.withPrices(result);
  }

  /** Rule SC9: the node's own link removed; the game, its products and routes stay. */
  async unlink(actor: Actor, code: string, categoryId: string): Promise<SupplierCategoryNode> {
    const supplier = await this.live.supplier(code);
    await this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, supplier.id, categoryId);
      if (row.gameId === null) return;
      await tx
        .update(supplierCategories)
        .set({ gameId: null, linkedAt: null, stateAdminId: actor.adminId, updatedAt: new Date() })
        .where(eq(supplierCategories.id, row.id));
      await auditSuppliers(tx, actor, 'supplier_category.unlinked', categoryEntity(row.id), {
        supplier: supplier.code,
        categoryId: row.categoryId,
        gameId: row.gameId,
      });
    });
    return this.node(code, categoryId);
  }

  /** Rule SC6: a node and its subtree leave the "not imported" view, or come back. */
  async setIgnored(
    actor: Actor,
    code: string,
    categoryId: string,
    ignored: boolean,
  ): Promise<SupplierCategoryNode> {
    const supplier = await this.live.supplier(code);
    await this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, supplier.id, categoryId);
      if ((row.ignoredAt !== null) === ignored) return;
      await tx
        .update(supplierCategories)
        .set({
          ignoredAt: ignored ? new Date() : null,
          stateAdminId: actor.adminId,
          updatedAt: new Date(),
        })
        .where(eq(supplierCategories.id, row.id));
      await auditSuppliers(
        tx,
        actor,
        ignored ? 'supplier_category.ignored' : 'supplier_category.unignored',
        categoryEntity(row.id),
        { supplier: supplier.code, categoryId: row.categoryId },
      );
    });
    return this.node(code, categoryId);
  }

  /**
   * Rule SC6: one offer no longer counts as new, or counts again. A mapped offer cannot be
   * ignored (`OFFER_ALREADY_MAPPED`). Returns the offer's id and supplier code for the answer.
   */
  async setOfferIgnored(actor: Actor, offerId: string, ignored: boolean): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(supplierOffers)
        .where(eq(supplierOffers.id, offerId))
        .for('update');
      if (!row) throw refusals.notFound('offer');
      if ((row.ignoredAt !== null) === ignored) return row.id;
      if (ignored && (await this.mappedOfferIds([row.id], tx)).size > 0) {
        throw new CodedException(409, 'OFFER_ALREADY_MAPPED', 'A mapped offer cannot be ignored');
      }
      await tx
        .update(supplierOffers)
        .set(
          ignored
            ? { ignoredAt: new Date(), ignoredAdminId: actor.adminId }
            : { ignoredAt: null, ignoredAdminId: null },
        )
        .where(eq(supplierOffers.id, row.id));
      const supplier = await this.live.supplierById(row.supplierId);
      await auditSuppliers(
        tx,
        actor,
        ignored ? 'supplier_offer.ignored' : 'supplier_offer.unignored',
        offerEntity(row.id),
        { supplier: supplier.code, offerId: row.offerId },
      );
      return row.id;
    });
  }

  /** IM3: the node's image downloaded again as the cover of the game it is linked to. */
  async coverFromSupplier(actor: Actor, gameId: string, code: string, categoryId: string) {
    const supplier = await this.live.supplier(code);
    const [row] = await this.db
      .select()
      .from(supplierCategories)
      .where(
        and(
          eq(supplierCategories.supplierId, supplier.id),
          eq(supplierCategories.categoryId, categoryId),
          eq(supplierCategories.gameId, gameId),
        ),
      );
    if (!row) throw refusals.notFound('category linked to this game');
    const image = await this.live.storeCover(supplier, row.imageUrl);
    return this.catalog.setCover(actor, gameId, image.id);
  }

  // Helpers -----------------------------------------------------------------------------------

  private async tree(supplierId: string): Promise<TreeView> {
    const { rows, standings } = await supplierCategoryTree(this.db, supplierId);
    return treeView(rows, standings);
  }

  /** The node and its ancestors, nearest first, stopping at a cycle. */
  private lineage(view: TreeView, categoryId: string): SupplierCategoryRow[] {
    const chain: SupplierCategoryRow[] = [];
    let row = view.byId.get(categoryId);
    while (row && !chain.includes(row)) {
      chain.push(row);
      row = row.parentCategoryId === null ? undefined : view.byId.get(row.parentCategoryId);
    }
    return chain;
  }

  /** The node's id and every id below it. */
  private subtree(view: TreeView, categoryId: string): Set<string> {
    const ids = new Set<string>([categoryId]);
    const queue = [categoryId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const child of view.children.get(id) ?? []) {
        if (ids.has(child.categoryId)) continue;
        ids.add(child.categoryId);
        queue.push(child.categoryId);
      }
    }
    return ids;
  }

  private async nodes(
    supplierCode: SupplierCategoryNode['supplierCode'],
    view: TreeView,
    rows: readonly SupplierCategoryRow[],
  ): Promise<SupplierCategoryNode[]> {
    const games = await this.catalog.gameNames(
      rows.flatMap((row) => {
        const id = view.standings.get(row.categoryId)?.effectiveGameId;
        return id ? [id] : [];
      }),
    );
    return rows.map((row) => {
      const standing = view.standings.get(row.categoryId) as CategoryStanding;
      const gameId = standing.effectiveGameId;
      return {
        supplierCode,
        categoryId: row.categoryId,
        parentCategoryId: row.parentCategoryId,
        name: row.name,
        path: this.lineage(view, row.categoryId)
          .slice(1)
          .reverse()
          .map((link) => link.name),
        kind: row.kind,
        productCount: row.productCount,
        inStockCount: row.inStockCount,
        hasImage: row.imageUrl !== null,
        childCount: view.children.get(row.categoryId)?.length ?? 0,
        counts: {
          mapped: standing.mapped,
          unmapped: standing.unmapped,
          ignored: standing.ignored,
          unsupported: standing.unsupported,
          newPacks: standing.newPacks,
        },
        state: standing.state,
        game: gameId ? { id: gameId, nameAr: games.get(gameId) ?? '' } : null,
        linkedHere: row.gameId !== null,
        ignoredAt: row.ignoredAt?.toISOString() ?? null,
        missingSince: row.missingSince?.toISOString() ?? null,
        lastSeenAt: row.lastSeenAt.toISOString(),
      };
    });
  }

  private async subtreeOffers(supplierId: string, subtree: Set<string>): Promise<OfferRow[]> {
    const rows = await this.db
      .select()
      .from(supplierOffers)
      .where(
        and(
          eq(supplierOffers.supplierId, supplierId),
          inArray(supplierOffers.categoryId, [...subtree]),
        ),
      );
    return rows.sort(
      (a, b) =>
        (a.categoryId as string).localeCompare(b.categoryId as string) ||
        (a.costUsdUnits ?? 0) - (b.costUsdUnits ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }

  /** The offers of a request's rows that sit in the node's subtree (others are `NOT_FOUND`). */
  private async rowOffers(
    supplierId: string,
    view: TreeView,
    row: SupplierCategoryRow,
    rows: readonly { offerId: string }[],
  ): Promise<Map<string, OfferRow>> {
    const subtree = this.subtree(view, row.categoryId);
    const found = await this.db
      .select()
      .from(supplierOffers)
      .where(
        and(
          eq(supplierOffers.supplierId, supplierId),
          inArray(
            supplierOffers.id,
            rows.map((item) => item.offerId),
          ),
        ),
      );
    return new Map(
      found
        .filter((offer) => offer.categoryId !== null && subtree.has(offer.categoryId))
        .map((offer) => [offer.id, offer]),
    );
  }

  private async mappedOfferIds(ids: readonly string[], db: Database | Transaction = this.db) {
    if (ids.length === 0) return new Set<string>();
    const rows = await db
      .select({ offerId: productRoutes.offerId })
      .from(productRoutes)
      .where(and(inArray(productRoutes.offerId, [...ids]), isNull(productRoutes.archivedAt)));
    return new Set(rows.map((row) => row.offerId));
  }

  /** Products of these ids with an unarchived route to the supplier (rule RT1). */
  private async productsRoutedTo(supplierId: string, productIds: readonly string[]) {
    if (productIds.length === 0) return new Set<string>();
    const rows = await this.db
      .select({ productId: productRoutes.productId })
      .from(productRoutes)
      .where(
        and(
          eq(productRoutes.supplierId, supplierId),
          inArray(productRoutes.productId, [...productIds]),
          isNull(productRoutes.archivedAt),
        ),
      );
    return new Set(rows.map((row) => row.productId));
  }

  /**
   * The node for an import (`gameId` null) or a link: it exists, is listed, and neither it, an
   * ancestor nor a descendant is linked to another game (`CATEGORY_LINKED`, `details.gameId`).
   */
  private linkable(view: TreeView, categoryId: string, gameId: string | null) {
    const row = view.byId.get(categoryId);
    if (!row) throw refusals.notFound('category');
    if (row.missingSince) throw categoryMissing();
    const related = [
      ...this.lineage(view, categoryId),
      ...[...this.subtree(view, categoryId)].map((id) => view.byId.get(id) as SupplierCategoryRow),
    ];
    const other = related.find((link) => link.gameId !== null && link.gameId !== gameId);
    if (other) throw categoryLinked(other.gameId as string);
    return row;
  }

  /**
   * The node locked for the change, its tree checked again under the lock: another admin may have
   * linked it, or a node around it, since the request was read. One link change at a time per
   * supplier: a node's ancestors and descendants are rows of their own, so the check needs one
   * lock above them all.
   */
  private async lockNode(
    tx: Transaction,
    supplierId: string,
    categoryId: string,
    gameId: string | null,
  ): Promise<SupplierCategoryRow> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('supplier_categories_link'), hashtext(${supplierId}))`,
    );
    const row = await this.lockRow(tx, supplierId, categoryId);
    const { rows, standings } = await supplierCategoryTree(tx, supplierId);
    this.linkable(treeView(rows, standings), categoryId, gameId);
    return row;
  }

  private async lockRow(tx: Transaction, supplierId: string, categoryId: string) {
    const [row] = await tx
      .select()
      .from(supplierCategories)
      .where(
        and(
          eq(supplierCategories.supplierId, supplierId),
          eq(supplierCategories.categoryId, categoryId),
        ),
      )
      .for('update');
    if (!row) throw refusals.notFound('category');
    return row;
  }

  private async link(tx: Transaction, actor: Actor, row: SupplierCategoryRow, gameId: string) {
    await tx
      .update(supplierCategories)
      .set({ gameId, linkedAt: new Date(), stateAdminId: actor.adminId, updatedAt: new Date() })
      .where(eq(supplierCategories.id, row.id));
  }

  /**
   * One enabled route per target (rules RT1–RT3), its field map limited to the offer's own fields
   * so a supplier is never sent a field it did not ask for; each audited.
   */
  private async insertRoutes(
    tx: Transaction,
    actor: Actor,
    supplier: { id: string; code: SupplierCategoryNode['supplierCode'] },
    targets: readonly { productId: string; offer: OfferRow }[],
    fieldMap: Record<string, string>,
  ): Promise<string[]> {
    const routes = targets.map((target) => {
      const required = target.offer.requiredFields ?? Object.keys(fieldMap);
      return {
        id: newId(),
        productId: target.productId,
        supplierId: supplier.id,
        offerId: target.offer.id,
        fieldMap: Object.fromEntries(
          Object.entries(fieldMap).filter(([key]) => required.includes(key)),
        ),
      };
    });
    if (routes.length === 0) return [];
    await tx.insert(productRoutes).values(routes);
    for (const route of routes) {
      await auditSuppliers(tx, actor, 'product_route.created', routeEntity(route.id), {
        supplier: supplier.code,
        productId: route.productId,
        offerId: route.offerId,
        priority: 1,
        enabled: true,
        fieldMap: route.fieldMap,
      });
    }
    return routes.map((route) => route.id);
  }

  private async withPrices(
    result: Omit<CategoryImportResult, 'products'> & {
      products: Omit<CategoryImportResult['products'][number], 'priceUsdUnits'>[];
    },
  ): Promise<CategoryImportResult> {
    const states = await productRoutingStates(
      this.db,
      result.products.map((product) => product.id),
      routingContext(this.env),
    );
    return {
      gameId: result.gameId,
      products: result.products.map((product) => ({
        ...product,
        priceUsdUnits: states.get(product.id)?.current?.priceUsdUnits ?? null,
      })),
    };
  }

  /** Rule SC14: the English name's slug, made unique with a number. */
  private async freeSlug(nameEn: string): Promise<string> {
    const base =
      nameEn
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 44)
        .replace(/-+$/, '') || 'game';
    const padded = base.length < 2 ? `${base}-game` : base;
    const candidates = [padded, ...Array.from({ length: 20 }, (_, n) => `${padded}-${n + 2}`)];
    const free = await this.catalog.freeSlugs(candidates);
    return candidates.find((slug) => free.has(slug)) ?? `${padded}-${newId().slice(-6)}`;
  }
}

/** The node rows with their parents and children; a parent not held makes a root. */
function treeView(rows: SupplierCategoryRow[], standings: Map<string, CategoryStanding>): TreeView {
  const byId = new Map(rows.map((row) => [row.categoryId, row]));
  const children = new Map<string | null, SupplierCategoryRow[]>();
  for (const row of rows) {
    const parent =
      row.parentCategoryId !== null && byId.has(row.parentCategoryId) ? row.parentCategoryId : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  return { rows, byId, children, standings };
}

const categoryMissing = () =>
  new CodedException(409, 'CATEGORY_MISSING', 'The supplier no longer lists the category');

const categoryLinked = (gameId: string) =>
  new CodedException(409, 'CATEGORY_LINKED', 'The category tree is linked to another game', {
    gameId,
  });

/** Why a pack cannot be imported or linked now (rules SC3, SC6, RT1), or null. */
function packRefusal(
  offer: OfferRow,
  mapped: ReadonlySet<string>,
): (typeof IMPORT_PACK_REFUSALS)[number] | null {
  if (offer.missingSince) return 'OFFER_MISSING';
  if (offer.unsupportedReason) return 'OFFER_UNSUPPORTED';
  if (mapped.has(offer.id)) return 'OFFER_ALREADY_MAPPED';
  if (offer.ignoredAt) return 'OFFER_IGNORED';
  return null;
}

/** A request row's refusal (rules SC3, SC7, RT1, RT3), or null. */
function rowError(
  offer: OfferRow | undefined,
  mapped: ReadonlySet<string>,
  fieldMap: Record<string, string>,
): Omit<RowError, 'index'> | null {
  if (!offer) return { code: 'NOT_FOUND' };
  const refusal = packRefusal(offer, mapped);
  if (refusal) return { code: refusal };
  const fields = unmappedFields(offer.requiredFields, fieldMap);
  if (fields.length > 0) return { code: 'ROUTE_FIELDS_UNMAPPED', fields };
  return null;
}

/** Refuses a request with every refused row; the first row's code is the refusal's. */
function refuseRows(errors: RowError[]): void {
  const [first] = errors;
  if (!first) return;
  const status = first.code === 'NOT_FOUND' ? 404 : 409;
  throw new CodedException(status, first.code as 'NOT_FOUND', 'Some rows cannot be imported', {
    rows: errors,
  });
}

/** A catalog refusal of new rows, numbered back to the request's rows. */
function renumbered(error: unknown, indices: readonly number[]): unknown {
  if (!(error instanceof CodedException)) return error;
  const body = error.getResponse() as { details?: { rows?: RowError[] } };
  const rows = body.details?.rows;
  if (!rows) return error;
  return new CodedException(409, (rows[0]?.code ?? 'NAME_TAKEN') as 'NAME_TAKEN', error.message, {
    rows: rows.map((row) => ({ ...row, index: indices[row.index] ?? row.index })),
  });
}

/** A route's unique index raised under a race (rule RT1). */
function rethrowRouteTaken(error: unknown): never {
  throw routeTakenRefusal(error) ?? error;
}

/** The offer's kind, else the node's, else a top-up. */
function kindOf(offer: OfferRow, node: SupplierCategoryRow): ProductKind {
  return offer.kind ?? node.kind ?? 'direct';
}

/** The most frequent kind, or null without any. */
function majority(kinds: readonly ProductKind[]): ProductKind | null {
  if (kinds.length === 0) return null;
  const direct = kinds.filter((kind) => kind === 'direct').length;
  return direct * 2 >= kinds.length ? 'direct' : 'code';
}

/** Rule SC14: printable ASCII of the supplier's name, 1–60 characters. */
function englishName(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return ascii || 'Game';
}

/**
 * Rule SC8's proposed map onto a game's fields: a suggested key the game has, else its only
 * field; a supplier field left without a match stays out (the dialog asks).
 */
function linkFieldMap(
  suggested: Record<string, string>,
  liveKeys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(suggested).flatMap(([supplierKey, key]) => {
      if (liveKeys.includes(key)) return [[supplierKey, key]];
      return liveKeys.length === 1 ? [[supplierKey, liveKeys[0] as string]] : [];
    }),
  );
}
