import { Inject, Injectable } from '@nestjs/common';
import {
  type BestValuePack,
  bestValue,
  type CatalogImageWidth,
  type CustomerPrices,
  gameServiceStatus,
  inEarlyAccess,
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
  accountPriceList,
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  type Database,
  merchantEarlyAccess,
  outsideEarlyAccess,
  type PlayerCheckProvider,
  type ProductRoutingState,
  playerCheckProviders,
  productDeliveryStats,
  productRoutingStates,
  uuidIn,
} from '@vertex-digital/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { RatesService } from '../rates/index.js';
import { refusals, toImage } from './catalog-records.js';

type GameRow = typeof catalogGames.$inferSelect;
type ProductRow = typeof catalogProducts.$inferSelect;
type ProductStatusRow = Pick<ProductRow, 'id' | 'gameId' | 'status'>;

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
    const [products, images] = await Promise.all([
      this.storefrontProducts(shown.map(({ game }) => game.id)),
      this.images(
        shown.map(({ game }) => game),
        shown.flatMap(({ category }) => (category.imageFileId ? [category.imageFileId] : [])),
      ),
    ]);
    const states = await this.sellableStates(products);
    const statusOf = serviceStatusOf(products, states);
    const categories: Storefront['categories'] = [];
    for (const { game, category } of shown) {
      let section = categories.at(-1);
      if (section?.slug !== category.slug) {
        section = {
          slug: category.slug,
          nameAr: category.nameAr,
          image: category.imageFileId ? imageOf(category.imageFileId, images) : null,
          games: [],
        };
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
    const [found] = await this.shownGames(slug);
    if (!found) throw refusals.notFound('game');
    return this.gameData(found.game, false);
  }

  /**
   * `GET /api/catalog/games/:slug/early-access` (S23 OP5, edge case 13): a game in a running
   * early-access window, with every pack, for a merchant whose tier has early access; not found
   * for everyone else and for a game outside a window (the public read serves it then).
   */
  async earlyAccessGame(customerId: string, slug: string, now = new Date()): Promise<StoreGame> {
    if (!(await merchantEarlyAccess(this.db, customerId))) throw refusals.notFound('game');
    const [found] = await this.shownGames(slug, true);
    if (!found || !inEarlyAccess(found.game.earlyAccessUntil, now)) {
      throw refusals.notFound('game');
    }
    return this.gameData(found.game, true);
  }

  private async gameData(game: GameRow, earlyAccess: boolean): Promise<StoreGame> {
    const [fields, products, rate, images] = await Promise.all([
      this.db
        .select()
        .from(catalogInputFields)
        .where(and(eq(catalogInputFields.gameId, game.id), isNull(catalogInputFields.archivedAt)))
        .orderBy(asc(catalogInputFields.sortOrder)),
      this.liveProducts([game.id], earlyAccess),
      this.rates.current(),
      this.images([game]),
    ]);
    const states = await this.states(products, earlyAccess);
    const storeProducts = await this.storeProducts(game, products, states, rate);
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
      products: withBestValue(storeProducts, game.bestValueEnabled),
      rateId: rate?.id ?? null,
    };
  }

  /**
   * The store shape of a game's packs from their routing states (rules SF2, SF3, PV1), before the
   * best value; S23 OP5: `earlyAccess` marks a pack in a running window (its own or its game's).
   */
  private async storeProducts(
    game: GameRow,
    products: readonly ProductRow[],
    states: Map<string, ProductRoutingState>,
    rate: Awaited<ReturnType<RatesService['current']>>,
  ): Promise<Omit<StoreProduct, 'perHundredUsdUnits' | 'bestValue'>[]> {
    const [delivery, providers] = await Promise.all([
      productDeliveryStats(
        this.db,
        products.map((product) => product.id),
      ),
      playerCheckProviders(this.db, [game.id]),
    ]);
    const provider = providers.get(game.id);
    return products.map((row) => {
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
        playerCheck: row.kind === 'direct' && this.checksPlayers(state, provider),
        regionAr: row.regionAr,
        redemptionAr: row.redemptionAr,
        earlyAccess: (state?.earlyAccessUntil ?? null) !== null,
      };
    });
  }

  /**
   * `GET /api/catalog/games/:slug/prices` (S20 AT4, PO1): the signed-in account's prices for the
   * game's packs on its effective list, each available only with a row on that list. Never cached
   * and never a list's name; the public reads above stay retail for everyone. S23 OP5: a merchant
   * of an early-access tier also reads the packs in early access in full (`earlyProducts`), which
   * the cached page leaves out.
   */
  async customerPrices(customerId: string, slug: string): Promise<CustomerPrices> {
    const earlyAccess = await merchantEarlyAccess(this.db, customerId);
    const [found] = await this.shownGames(slug, earlyAccess);
    if (!found) throw refusals.notFound('game');
    const [products, rate, pricing] = await Promise.all([
      this.liveProducts([found.game.id], earlyAccess),
      this.rates.current(),
      accountPriceList(this.db, customerId),
    ]);
    if (!pricing) throw refusals.notFound('customer');
    const states = await productRoutingStates(
      this.db,
      products.map((product) => product.id),
      { ...routingContext(this.env), earlyAccess },
      pricing.effectiveList.id,
    );
    const early = products.filter((row) => (states.get(row.id)?.earlyAccessUntil ?? null) !== null);
    const prices = products.map((row) => {
      const state = states.get(row.id);
      const price =
        state?.availability === 'available' ? (state.current?.priceUsdUnits ?? null) : null;
      const saving = price !== null ? savings(price, row.officialPriceUsdUnits) : null;
      return {
        id: row.id,
        // For the best value (dropped by the response schema).
        kind: row.kind,
        gameAmount: row.gameAmount,
        available: price !== null,
        priceUsdUnits: price,
        priceSypUnits:
          price !== null && rate
            ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits)
            : null,
        savings: saving && { amountUsdUnits: saving.amountUsdUnits, percent: saving.percent },
        earlyAccess: (state?.earlyAccessUntil ?? null) !== null,
      };
    });
    // S22 BV3: the badge over the account's own prices.
    const ranked = withBestValue(prices, found.game.bestValueEnabled);
    const full = await this.storeProducts(found.game, early, states, rate);
    return {
      priceKind: pricing.priceKind,
      products: ranked,
      earlyProducts: full.map((product) => {
        const own = ranked.find((row) => row.id === product.id);
        return {
          ...product,
          perHundredUsdUnits: own?.perHundredUsdUnits ?? null,
          bestValue: own?.bestValue ?? false,
        };
      }),
      rateId: rate?.id ?? null,
    };
  }

  /** `GET /api/catalog/search-index` (rule SR2). */
  async searchIndex(): Promise<SearchIndex> {
    const shown = await this.shownGames();
    const products = await this.liveProducts(shown.map(({ game }) => game.id));
    const [states, rate, images] = await Promise.all([
      this.sellableStates(products),
      this.rates.current(),
      this.images(shown.map(({ game }) => game)),
    ]);
    const slugOf = new Map(shown.map(({ game }) => [game.id, game.slug]));
    const statusOf = serviceStatusOf(products, states);
    return {
      games: shown.map(({ game, category }) => ({
        id: game.id,
        slug: game.slug,
        nameAr: game.nameAr,
        nameEn: game.nameEn,
        cover: game.coverFileId ? imageOf(game.coverFileId, images) : null,
        status: statusOf(game.id),
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
  /**
   * The shown games in store order; one game's row only for a slug (audit A03-37). S23 OP5: a game
   * in a running early-access window only with `earlyAccess`.
   */
  private async shownGames(slug?: string, earlyAccess = false) {
    return this.db
      .select({ game: catalogGames, category: catalogCategories })
      .from(catalogGames)
      .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
      .where(
        and(
          eq(catalogGames.status, 'active'),
          isNull(catalogGames.archivedAt),
          isNull(catalogCategories.archivedAt),
          slug === undefined ? undefined : eq(catalogGames.slug, slug),
          earlyAccess ? undefined : outsideEarlyAccess(catalogGames.earlyAccessUntil, new Date()),
        ),
      )
      .orderBy(
        asc(catalogCategories.sortOrder),
        asc(catalogCategories.createdAt),
        asc(catalogGames.sortOrder),
        asc(catalogGames.createdAt),
      );
  }

  /**
   * The games' unarchived products, paused ones included (shown greyed, rule SF1); S23 OP5: those
   * in early access only with `earlyAccess`.
   */
  private async liveProducts(
    gameIds: readonly string[],
    earlyAccess = false,
  ): Promise<ProductRow[]> {
    if (gameIds.length === 0) return [];
    return this.db
      .select()
      .from(catalogProducts)
      .where(
        and(
          uuidIn(catalogProducts.gameId, gameIds),
          isNull(catalogProducts.archivedAt),
          earlyAccess
            ? undefined
            : outsideEarlyAccess(catalogProducts.earlyAccessUntil, new Date()),
        ),
      )
      .orderBy(asc(catalogProducts.sortOrder), asc(catalogProducts.createdAt));
  }

  /** What `storefront` needs of `liveProducts`: the catalog's texts stay out of the home read. */
  private async storefrontProducts(gameIds: readonly string[]): Promise<ProductStatusRow[]> {
    if (gameIds.length === 0) return [];
    return this.db
      .select({
        id: catalogProducts.id,
        gameId: catalogProducts.gameId,
        status: catalogProducts.status,
      })
      .from(catalogProducts)
      .where(
        and(
          uuidIn(catalogProducts.gameId, gameIds),
          isNull(catalogProducts.archivedAt),
          outsideEarlyAccess(catalogProducts.earlyAccessUntil, new Date()),
        ),
      );
  }

  /**
   * The states of the products that can be available. A paused product never is, so for the
   * storefront and the search index (rules SS1, SR2) a missing state means the same as its own,
   * and those reads skip the routes and offers of the catalog's paused packs.
   */
  private sellableStates(products: readonly ProductStatusRow[]) {
    return this.states(products.filter((product) => product.status === 'active'));
  }

  private states(products: readonly Pick<ProductRow, 'id'>[], earlyAccess = false) {
    return productRoutingStates(
      this.db,
      products.map((product) => product.id),
      { ...routingContext(this.env), earlyAccess },
    );
  }

  private images(rows: readonly GameRow[], others: readonly string[] = []) {
    const ids = rows.flatMap((row) =>
      [row.coverFileId, row.idGuideFileId].filter((id): id is string => id !== null),
    );
    return this.files.dimensions([...new Set([...ids, ...others])], 'catalog_image');
  }

  /**
   * Rule PV1 for the store's flag: a usable route on a supplier that checks player ids here, with
   * a quota above 0 (today's usage aside: the buy box learns it from the check). S19 PC1: a game's
   * enabled provider answers for every pack instead, its pause or outage aside (PC5).
   */
  private checksPlayers(
    state: ProductRoutingState | undefined,
    provider: PlayerCheckProvider | undefined,
  ): boolean {
    if (provider?.enabled) {
      return (
        supplierChecksPlayers(provider.supplierCode, {
          fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
          by: 'provider',
        }) && provider.validationDailyQuota > 0
      );
    }
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

/** Each game's service status, its products grouped once rather than searched per game. */
function serviceStatusOf(
  products: readonly ProductStatusRow[],
  states: Map<string, ProductRoutingState>,
): (gameId: string) => ReturnType<typeof gameServiceStatus> {
  const facts = new Map<string, ReturnType<typeof serviceFacts>[]>();
  for (const product of products) {
    const list = facts.get(product.gameId) ?? [];
    list.push(serviceFacts(states.get(product.id)));
    facts.set(product.gameId, list);
  }
  return (gameId) => gameServiceStatus(facts.get(gameId) ?? []);
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

/** S22 BV1–BV2: the per-100 price and the badge over the prices shown. */
function withBestValue<Pack extends BestValuePack>(
  packs: Pack[],
  enabled: boolean,
): (Pack & { perHundredUsdUnits: number | null; bestValue: boolean })[] {
  const value = bestValue(packs, enabled);
  return packs.map((pack) => ({
    ...pack,
    perHundredUsdUnits: value.perHundredUsdUnits[pack.id] ?? null,
    bestValue: value.bestProductId === pack.id,
  }));
}
