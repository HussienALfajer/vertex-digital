import { Inject, Injectable } from '@nestjs/common';
import {
  type CatalogImageWidth,
  gameServiceStatus,
  type SearchIndex,
  type Storefront,
  type StoreGame,
  type StoreProduct,
  savings,
  storeServiceState,
  supplierChecksPlayers,
  sypDisplayPrice,
} from '@vertex-digital/contracts';
import {
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  type Database,
  type ProductRoutingState,
  productDeliveryStats,
  productRoutingStates,
} from '@vertex-digital/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { RatesService } from '../rates/index.js';
import { refusals, toImage } from './catalog-records.js';

type GameRow = typeof catalogGames.$inferSelect;
type ProductRow = typeof catalogProducts.$inferSelect;

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * The store's public catalog reads (S09 rules SF1–SF5, SS1–SS3, SR2): only active games of live
 * categories, their unarchived products with the current price and availability, and a service
 * status per game. Never a supplier, a cost or a health number (SS3); never a customer's data,
 * so the answers can be cached by anyone.
 */
@Injectable()
export class CatalogStoreService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly files: FilesService,
    private readonly rates: RatesService,
  ) {}

  /** `GET /api/catalog/storefront` (rules SF1, SS2). */
  async storefront(): Promise<Storefront> {
    const shown = await this.shownGames();
    const products = await this.liveProducts(shown.map(({ game }) => game.id));
    const states = await this.states(products);
    const images = await this.images(shown.map(({ game }) => game));
    const statusOf = (gameId: string) =>
      gameServiceStatus(
        products
          .filter((product) => product.gameId === gameId)
          .map((product) => serviceFacts(states.get(product.id))),
      );
    const categories: Storefront['categories'] = [];
    for (const { game, category } of shown) {
      let section = categories.at(-1);
      if (section?.slug !== category.slug) {
        section = { slug: category.slug, nameAr: category.nameAr, games: [] };
        categories.push(section);
      }
      section.games.push({ ...card(game, images), status: statusOf(game.id) });
    }
    return {
      service: storeServiceState(
        categories.flatMap((section) => section.games.map((g) => g.status)),
      ),
      categories,
    };
  }

  /** `GET /api/catalog/games/:slug` (rules SF1–SF3, BB1); a paused or archived game is not found. */
  async game(slug: string): Promise<StoreGame> {
    const [found] = (await this.shownGames()).filter(({ game }) => game.slug === slug);
    if (!found) throw refusals.notFound('game');
    const { game } = found;
    const [fields, products, rate, images] = await Promise.all([
      this.db
        .select()
        .from(catalogInputFields)
        .where(and(eq(catalogInputFields.gameId, game.id), isNull(catalogInputFields.archivedAt)))
        .orderBy(asc(catalogInputFields.sortOrder)),
      this.liveProducts([game.id]),
      this.rates.current(),
      this.images([game]),
    ]);
    const [states, delivery] = await Promise.all([
      this.states(products),
      productDeliveryStats(
        this.db,
        products.map((product) => product.id),
      ),
    ]);
    const storeProducts = products.map((row): StoreProduct => {
      const state = states.get(row.id);
      const available = state?.availability === 'available';
      const price = available ? (state?.current?.priceUsdUnits ?? null) : null;
      const saving = price !== null ? savings(price, row.officialPriceUsdUnits) : null;
      return {
        id: row.id,
        kind: row.kind,
        nameAr: row.nameAr,
        gameAmount: row.gameAmount,
        maxQuantity: row.maxQuantity,
        available: available && price !== null,
        priceUsdUnits: price,
        priceSypUnits:
          price !== null && rate
            ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits)
            : null,
        savings: saving && { amountUsdUnits: saving.amountUsdUnits, percent: saving.percent },
        deliveryStats: delivery.get(row.id) ?? null,
        playerCheck: row.kind === 'direct' && this.checksPlayers(state),
        regionAr: row.regionAr,
        redemptionAr: row.redemptionAr,
      };
    });
    return {
      game: {
        ...card(game, images),
        status: gameServiceStatus(products.map((product) => serviceFacts(states.get(product.id)))),
        idGuide: game.idGuideFileId ? imageOf(game.idGuideFileId, images) : null,
        regionNotesAr: game.regionNotesAr,
      },
      fields: fields.map((field) => ({
        key: field.key,
        labelAr: field.labelAr,
        helpAr: field.helpAr,
        type: field.type,
        required: field.required,
        minLength: field.minLength,
        maxLength: field.maxLength,
        options: field.options,
      })),
      products: storeProducts,
      rateId: rate?.id ?? null,
    };
  }

  /** `GET /api/catalog/search-index` (rule SR2). */
  async searchIndex(): Promise<SearchIndex> {
    const shown = await this.shownGames();
    const products = await this.liveProducts(shown.map(({ game }) => game.id));
    const [states, rate, images] = await Promise.all([
      this.states(products),
      this.rates.current(),
      this.images(shown.map(({ game }) => game)),
    ]);
    const slugOf = new Map(shown.map(({ game }) => [game.id, game.slug]));
    return {
      games: shown.map(({ game, category }) => ({
        id: game.id,
        slug: game.slug,
        nameAr: game.nameAr,
        nameEn: game.nameEn,
        cover: game.coverFileId ? imageOf(game.coverFileId, images) : null,
        status: gameServiceStatus(
          products
            .filter((product) => product.gameId === game.id)
            .map((product) => serviceFacts(states.get(product.id))),
        ),
        searchTerms: game.searchTerms,
        categoryNameAr: category.nameAr,
      })),
      products: products.map((row) => {
        const state = states.get(row.id);
        const price =
          state?.availability === 'available' ? (state.current?.priceUsdUnits ?? null) : null;
        return {
          id: row.id,
          gameSlug: slugOf.get(row.gameId) as string,
          nameAr: row.nameAr,
          gameAmount: row.gameAmount,
          available: price !== null,
          priceUsdUnits: price,
          priceSypUnits:
            price !== null && rate
              ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits)
              : null,
        };
      }),
    };
  }

  /**
   * The public image route (S06 rule CT10): catalog images only, never receipts or QR images;
   * S09 rule SF5: at one of the store widths, or the stored one.
   */
  async image(id: string, width: CatalogImageWidth | undefined): Promise<ServedFile> {
    const file = !isUuid(id)
      ? null
      : width === undefined
        ? await this.files.serve(id, 'catalog_image')
        : await this.files.catalogVariant(id, width);
    if (!file) throw refusals.notFound('catalog image');
    return file;
  }

  /** Rule SF1: active, unarchived games of unarchived categories, category then game order. */
  private async shownGames() {
    return this.db
      .select({ game: catalogGames, category: catalogCategories })
      .from(catalogGames)
      .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
      .where(
        and(
          eq(catalogGames.status, 'active'),
          isNull(catalogGames.archivedAt),
          isNull(catalogCategories.archivedAt),
        ),
      )
      .orderBy(
        asc(catalogCategories.sortOrder),
        asc(catalogCategories.createdAt),
        asc(catalogGames.sortOrder),
        asc(catalogGames.createdAt),
      );
  }

  /** The games' unarchived products, paused ones included (shown greyed, rule SF1). */
  private async liveProducts(gameIds: readonly string[]): Promise<ProductRow[]> {
    if (gameIds.length === 0) return [];
    return this.db
      .select()
      .from(catalogProducts)
      .where(and(inArray(catalogProducts.gameId, [...gameIds]), isNull(catalogProducts.archivedAt)))
      .orderBy(asc(catalogProducts.sortOrder), asc(catalogProducts.createdAt));
  }

  private states(products: readonly ProductRow[]) {
    return productRoutingStates(
      this.db,
      products.map((product) => product.id),
      routingContext(this.env),
    );
  }

  private images(rows: readonly GameRow[]) {
    const ids = rows.flatMap((row) =>
      [row.coverFileId, row.idGuideFileId].filter((id): id is string => id !== null),
    );
    return this.files.dimensions(ids, 'catalog_image');
  }

  /**
   * Rule PV1 for the store's flag: a usable route on a supplier that checks player ids here, with
   * a quota above 0 (today's usage aside: the buy box learns it from the check).
   */
  private checksPlayers(state: ProductRoutingState | undefined): boolean {
    return (
      state?.routes.some(
        (route) =>
          route.unusableReason === null &&
          supplierChecksPlayers(route.supplierCode, {
            fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
          }) &&
          route.supplier.validationDailyQuota > 0,
      ) ?? false
    );
  }
}

/** Rule SS1's facts of one product: available, and its basis route automatic and healthy. */
function serviceFacts(state: ProductRoutingState | undefined) {
  return {
    available: state?.availability === 'available',
    healthyAutomaticBasis: state?.basis?.tier === 'healthy',
  };
}

type Images = Map<string, { width: number; height: number }>;

function imageOf(id: string, images: Images) {
  const size = images.get(id);
  return size ? toImage(id, size) : null;
}

function card(game: GameRow, images: Images) {
  return {
    id: game.id,
    slug: game.slug,
    nameAr: game.nameAr,
    nameEn: game.nameEn,
    cover: game.coverFileId ? imageOf(game.coverFileId, images) : null,
    accentColor: game.accentColor,
  };
}
