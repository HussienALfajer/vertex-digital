import {
  ACCENT_DARK_SURFACE,
  ACCENT_MIN_CONTRAST,
  type CatalogImage,
  type CatalogMissingItem,
  type Category,
  contrastRatio,
  DEFAULT_MAX_QUANTITY,
  type Game,
  type InputField,
  type MarginRule,
  type MarginRuleValues,
  type MarginScope,
  marginBasisPoints,
  missingForActivation,
  type Product,
  type ProductAvailability,
  type ProductKind,
  priceFromCost,
  productAvailability,
  resolveMarginRule,
  savings,
  sypDisplayPrice,
} from '@vertex-digital/contracts';

/*
 * The catalog and pricing API of S06 as the panel sees it: a small state machine with the spec's
 * rules (CT1–CT6, PR2, PR3–PR9), so the flows run against the same refusals the API gives.
 */

type Body = Record<string, unknown> | null;

/** What a route answers: a status and a JSON body, an image, or nothing. */
export type Answer =
  | { status: number; json?: unknown }
  | { status: 200; image: true }
  | { status: 204 };

/** What the API derives rather than stores (S06 counts; S07 a product's price and availability). */
type Row<T> = Omit<
  T,
  | 'gameCount'
  | 'productCount'
  | 'availability'
  | 'priceUsdUnits'
  | 'priceSypUnits'
  | 'basisSupplierNameAr'
  | 'reviewOpen'
  | 'deliveryStats'
>;

type StoredGame = Omit<Row<Game>, 'cover' | 'idGuide'> & {
  coverFileId: string | null;
  idGuideFileId: string | null;
};

/** What the suppliers mock tells the catalog about a product's price (S07). */
export interface ProductPricing {
  price: { priceUsdUnits: number; minMarginUsdUnits: number } | null;
  usableRouteCostsUsdUnits: number[];
  basisSupplierNameAr: string | null;
  reviewOpen: boolean;
}

type StoredRule = MarginRuleValues & {
  id: string;
  scope: MarginScope;
  targetId: string | null;
  updatedAt: string;
};

const NOW = '2026-10-08T09:00:00.000Z';

let sequence = 0;
/** A UUIDv7-shaped id, unique within the run. */
export const nextId = () =>
  `0199a000-0000-7000-8000-${(0xc00 + ++sequence).toString(16).padStart(12, '0')}`;

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const notFound = () => error(404, 'NOT_FOUND');

export class CatalogMock {
  categories: Row<Category>[] = [
    ['games', 'ألعاب'],
    ['apps', 'تطبيقات'],
    ['gift-cards', 'بطاقات هدايا'],
  ].map(([slug, nameAr], index) => ({
    id: nextId(),
    slug: slug as string,
    nameAr: nameAr as string,
    sortOrder: index + 1,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  games: StoredGame[] = [];
  fields: Row<InputField>[] = [];
  products: Row<Product>[] = [];
  images = new Map<string, CatalogImage>();
  rules: StoredRule[] = [
    {
      id: nextId(),
      scope: 'global',
      targetId: null,
      percentBp: 1000,
      fixedUsdUnits: 0,
      minMarginUsdUnits: 100_000,
      updatedAt: NOW,
    },
  ];

  /**
   * S07: a product's stored price and what its availability reads (rules P2, P6), from the
   * suppliers mock; without it a product has no price and no route.
   */
  pricing: ((productId: string) => ProductPricing) | null = null;

  /** S07 rule P5: a rule change reprices what it governs. */
  onRulesChanged: () => void = () => {};

  constructor(
    /** The current rate (S03), for SYP prices (rule PR8). */
    private readonly rate: () => { sypPerUsd: string; displayStepSypUnits: number } | null,
    /** Rule routes answer `REAUTHENTICATION_REQUIRED` while this says so (rule D5). */
    private readonly reauthenticationRequired: () => boolean,
  ) {}

  /** A game with its fields and products, as a test sets the scene. */
  addGame(values: {
    categorySlug: string;
    slug: string;
    nameAr: string;
    nameEn: string;
    status?: 'active' | 'paused';
    cover?: boolean;
  }): StoredGame {
    const category = this.categories.find((item) => item.slug === values.categorySlug);
    if (!category) throw new Error(`No category ${values.categorySlug}`);
    const cover = values.cover ? this.upload() : null;
    const game: StoredGame = {
      id: nextId(),
      categoryId: category.id,
      slug: values.slug,
      nameAr: values.nameAr,
      nameEn: values.nameEn,
      status: values.status ?? 'paused',
      coverFileId: cover?.id ?? null,
      idGuideFileId: null,
      accentColor: null,
      regionNotesAr: null,
      sortOrder: this.games.filter((item) => item.categoryId === category.id).length + 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.games.push(game);
    return game;
  }

  addProduct(gameId: string, values: Partial<Row<Product>> & { nameAr: string }): Row<Product> {
    const kind = values.kind ?? 'direct';
    const product: Row<Product> = {
      id: nextId(),
      gameId,
      kind,
      gameAmount: null,
      officialPriceUsdUnits: null,
      maxQuantity: DEFAULT_MAX_QUANTITY[kind],
      regionAr: null,
      redemptionAr: null,
      status: 'active',
      sortOrder: this.products.filter((item) => item.gameId === gameId).length + 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...values,
    };
    this.products.push(product);
    return product;
  }

  addField(gameId: string, values: Partial<Row<InputField>> & { key: string; labelAr: string }) {
    const field: Row<InputField> = {
      id: nextId(),
      gameId,
      type: 'digits',
      required: true,
      helpAr: null,
      minLength: null,
      maxLength: null,
      options: null,
      sortOrder: this.fields.filter((item) => item.gameId === gameId).length + 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...values,
    };
    this.fields.push(field);
    return field;
  }

  private upload(): CatalogImage {
    const id = nextId();
    const image = { id, url: `/api/catalog/images/${id}`, width: 1200, height: 675 };
    this.images.set(id, image);
    return image;
  }

  private category(row: Row<Category>): Category {
    return {
      ...row,
      gameCount: this.games.filter((game) => game.categoryId === row.id && !game.archivedAt).length,
    };
  }

  private game(row: StoredGame): Game {
    const { coverFileId, idGuideFileId, ...rest } = row;
    return {
      ...rest,
      cover: coverFileId ? (this.images.get(coverFileId) ?? null) : null,
      idGuide: idGuideFileId ? (this.images.get(idGuideFileId) ?? null) : null,
      productCount: this.products.filter((item) => item.gameId === row.id && !item.archivedAt)
        .length,
    };
  }

  /** Rule CT9 with S07 rule P6: derived on read from the product and its routes. */
  availabilityOf(productId: string): ProductAvailability {
    const row = this.products.find((item) => item.id === productId) as Row<Product>;
    const game = this.games.find((item) => item.id === row.gameId) as StoredGame;
    const category = this.categories.find((item) => item.id === game.categoryId);
    const pricing = this.pricing?.(row.id);
    return productAvailability({
      categoryArchived: !!category?.archivedAt,
      gameArchived: !!game.archivedAt,
      productArchived: !!row.archivedAt,
      gameStatus: game.status,
      productStatus: row.status,
      price: pricing?.price ?? null,
      usableRouteCostsUsdUnits: pricing?.usableRouteCostsUsdUnits ?? [],
    });
  }

  /** A product's own margin rule, created or replaced (S07 rule P4's margin adjustment). */
  setProductRule(productId: string, values: MarginRuleValues): void {
    const row = this.rules.find((item) => item.scope === 'product' && item.targetId === productId);
    if (row) Object.assign(row, values, { updatedAt: new Date().toISOString() });
    else {
      this.rules.push({
        id: nextId(),
        scope: 'product',
        targetId: productId,
        ...values,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  /** The rule that governs a product (rule PR2). */
  ruleOf(productId: string): MarginRuleValues & { id: string } {
    return resolveMarginRule(this.rules, this.target('product', productId)?.path ?? {});
  }

  private product(row: Row<Product>): Product {
    const pricing = this.pricing?.(row.id);
    const rate = this.rate();
    const price = pricing?.price?.priceUsdUnits ?? null;
    return {
      ...row,
      availability: this.availabilityOf(row.id),
      priceUsdUnits: price,
      priceSypUnits:
        price !== null && rate
          ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits)
          : null,
      basisSupplierNameAr: pricing?.basisSupplierNameAr ?? null,
      reviewOpen: pricing?.reviewOpen ?? false,
      // S08: no delivered orders in the mock.
      deliveryStats: null,
    };
  }

  /** A product as the API answers it, for the routes drawer and the reviews. */
  productView(productId: string): Product | null {
    const row = this.products.find((item) => item.id === productId);
    return row ? this.product(row) : null;
  }

  private detail(row: StoredGame) {
    const bySort = <T extends { sortOrder: number }>(items: T[]) =>
      [...items].sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      ...this.game(row),
      categoryArchived: !!this.categories.find((item) => item.id === row.categoryId)?.archivedAt,
      fields: bySort(this.fields.filter((item) => item.gameId === row.id)),
      products: bySort(this.products.filter((item) => item.gameId === row.id)).map((item) =>
        this.product(item),
      ),
    };
  }

  /** Rule CT3: what the game would lack to be active. */
  private missing(gameId: string): CatalogMissingItem[] {
    const game = this.games.find((item) => item.id === gameId) as StoredGame;
    return missingForActivation({
      hasCover: !!game.coverFileId,
      hasDirectProduct: this.products.some(
        (item) => item.gameId === gameId && !item.archivedAt && item.kind === 'direct',
      ),
      hasRequiredField: this.fields.some(
        (item) => item.gameId === gameId && !item.archivedAt && item.required,
      ),
    });
  }

  /** Rule CT5: the full set of unarchived ids, rewritten 1…n. */
  private reorder<T extends { id: string; sortOrder: number; archivedAt: string | null }>(
    rows: T[],
    ids: unknown,
  ): T[] | null {
    const live = rows.filter((row) => !row.archivedAt);
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    if (list.length !== live.length || live.some((row) => !list.includes(row.id))) return null;
    for (const row of live) row.sortOrder = list.indexOf(row.id) + 1;
    return [...live].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** The pricing path of a target, or null when it is missing or archived. */
  private target(scope: MarginScope, id: string | null) {
    if (scope === 'global') return { path: {}, name: null, official: null, archived: false };
    if (scope === 'category') {
      const category = this.categories.find((item) => item.id === id);
      return category
        ? {
            path: { categoryId: category.id },
            name: category.nameAr,
            official: null,
            archived: !!category.archivedAt,
          }
        : null;
    }
    if (scope === 'game') {
      const game = this.games.find((item) => item.id === id);
      return game
        ? {
            path: { gameId: game.id, categoryId: game.categoryId },
            name: game.nameAr,
            official: null,
            archived: !!game.archivedAt,
          }
        : null;
    }
    const product = this.products.find((item) => item.id === id);
    const game = this.games.find((item) => item.id === product?.gameId);
    return product && game
      ? {
          path: { productId: product.id, gameId: game.id, categoryId: game.categoryId },
          name: product.nameAr,
          official: product.officialPriceUsdUnits,
          archived: !!product.archivedAt || !!game.archivedAt,
        }
      : null;
  }

  private rule(row: StoredRule): MarginRule {
    const target = this.target(row.scope, row.targetId);
    const governed = this.products.filter((product) => {
      if (product.archivedAt) return false;
      const path = this.target('product', product.id)?.path ?? {};
      return resolveMarginRule(this.rules, path).id === row.id;
    });
    return {
      ...row,
      targetName: target?.name ?? null,
      targetArchived: target?.archived ?? false,
      productCount: governed.length,
    };
  }

  /** Answers a catalog or pricing route, or null when `path` is not one of them. */
  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const match = (pattern: RegExp) => path.match(pattern)?.[1];

    if (method === 'GET' && match(/^\/api\/catalog\/images\/([^/]+)$/)) {
      return this.images.has(match(/^\/api\/catalog\/images\/([^/]+)$/) as string)
        ? { status: 200, image: true }
        : notFound();
    }
    if (key === 'POST /api/admin/catalog/images') return { status: 201, json: this.upload() };

    // Categories ----------------------------------------------------------------------------------
    if (key === 'GET /api/admin/catalog/categories') {
      const archived = url.searchParams.get('archived') === 'true';
      return {
        status: 200,
        json: this.categories
          .filter((item) => !!item.archivedAt === archived)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((item) => this.category(item)),
      };
    }
    if (key === 'POST /api/admin/catalog/categories') {
      if (this.categories.some((item) => item.slug === body?.slug)) return error(409, 'SLUG_TAKEN');
      if (this.categories.some((item) => !item.archivedAt && item.nameAr === body?.nameAr)) {
        return error(409, 'NAME_TAKEN');
      }
      const row: Row<Category> = {
        id: nextId(),
        slug: String(body?.slug),
        nameAr: String(body?.nameAr),
        sortOrder: this.categories.length + 1,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.categories.push(row);
      return { status: 201, json: this.category(row) };
    }
    if (key === 'PUT /api/admin/catalog/categories/order') {
      const rows = this.reorder(this.categories, body?.ids);
      return rows
        ? { status: 200, json: rows.map((item) => this.category(item)) }
        : error(400, 'VALIDATION_FAILED');
    }
    const categoryId = match(/^\/api\/admin\/catalog\/categories\/([^/]+)(?:\/.*)?$/);
    if (categoryId) {
      const row = this.categories.find((item) => item.id === categoryId);
      if (!row) return notFound();
      if (path.endsWith('/games/order') && method === 'PUT') {
        const rows = this.reorder(
          this.games.filter((item) => item.categoryId === row.id),
          body?.ids,
        );
        return rows
          ? { status: 200, json: rows.map((item) => this.game(item)) }
          : error(400, 'VALIDATION_FAILED');
      }
      if (path.endsWith('/archive')) {
        const left = this.games.filter((item) => item.categoryId === row.id && !item.archivedAt);
        if (left.length > 0) {
          return error(409, 'CATALOG_NOT_EMPTY', {
            games: left.map((item) => ({ id: item.id, nameAr: item.nameAr })),
          });
        }
        row.archivedAt = new Date().toISOString();
        return { status: 200, json: this.category(row) };
      }
      if (path.endsWith('/restore')) {
        row.archivedAt = null;
        row.sortOrder = this.categories.filter((item) => !item.archivedAt).length;
        return { status: 200, json: this.category(row) };
      }
      if (method === 'PATCH') {
        if (
          this.categories.some(
            (item) => item.id !== row.id && !item.archivedAt && item.nameAr === body?.nameAr,
          )
        ) {
          return error(409, 'NAME_TAKEN');
        }
        row.nameAr = String(body?.nameAr);
        return { status: 200, json: this.category(row) };
      }
    }

    // Games ---------------------------------------------------------------------------------------
    if (key === 'GET /api/admin/catalog/games') {
      const archived = url.searchParams.get('archived') === 'true';
      const category = url.searchParams.get('categoryId');
      const status = url.searchParams.get('status');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const items = this.games
        .filter((item) => !!item.archivedAt === archived)
        .filter((item) => !category || item.categoryId === category)
        .filter((item) => !status || item.status === status)
        .filter(
          (item) =>
            !q ||
            item.nameAr.includes(q) ||
            item.nameEn.toLowerCase().includes(q) ||
            item.slug.includes(q),
        )
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => this.game(item));
      return { status: 200, json: { items, total: items.length, page: 1, pageSize: 100 } };
    }
    if (key === 'POST /api/admin/catalog/games') {
      if (this.games.some((item) => item.slug === body?.slug)) return error(409, 'SLUG_TAKEN');
      if (this.games.some((item) => !item.archivedAt && item.nameAr === body?.nameAr)) {
        return error(409, 'NAME_TAKEN');
      }
      const refusal = this.accentRefusal(body?.accentColor);
      if (refusal) return refusal;
      const category = this.categories.find((item) => item.id === body?.categoryId);
      if (!category) return notFound();
      if (category.archivedAt) return error(409, 'PARENT_ARCHIVED');
      const row = this.addGame({
        categorySlug: category.slug,
        slug: String(body?.slug),
        nameAr: String(body?.nameAr),
        nameEn: String(body?.nameEn),
      });
      Object.assign(row, this.gameValues(body));
      return { status: 201, json: this.detail(row) };
    }
    const fieldsOrder = match(/^\/api\/admin\/catalog\/games\/([^/]+)\/fields\/order$/);
    const productsOrder = match(/^\/api\/admin\/catalog\/games\/([^/]+)\/products\/order$/);
    if (fieldsOrder || productsOrder) {
      const rows = fieldsOrder
        ? this.reorder(
            this.fields.filter((item) => item.gameId === fieldsOrder),
            body?.ids,
          )
        : this.reorder(
            this.products.filter((item) => item.gameId === productsOrder),
            body?.ids,
          );
      if (!rows) return error(400, 'VALIDATION_FAILED');
      return {
        status: 200,
        json: fieldsOrder ? rows : rows.map((item) => this.product(item as Row<Product>)),
      };
    }
    const newField = match(/^\/api\/admin\/catalog\/games\/([^/]+)\/fields$/);
    if (newField && method === 'POST') {
      if (this.fields.some((item) => item.gameId === newField && item.key === body?.key)) {
        return error(409, 'FIELD_KEY_TAKEN');
      }
      const field = this.addField(newField, {
        key: String(body?.key),
        labelAr: String(body?.labelAr),
        type: body?.type as InputField['type'],
        required: !!body?.required,
        helpAr: (body?.helpAr as string | null | undefined) ?? null,
        minLength: (body?.minLength as number | null | undefined) ?? null,
        maxLength: (body?.maxLength as number | null | undefined) ?? null,
        options: (body?.options as InputField['options'] | undefined) ?? null,
      });
      return { status: 201, json: field };
    }
    const newProduct = match(/^\/api\/admin\/catalog\/games\/([^/]+)\/products$/);
    if (newProduct && method === 'POST') {
      if (
        this.products.some(
          (item) => item.gameId === newProduct && !item.archivedAt && item.nameAr === body?.nameAr,
        )
      ) {
        return error(409, 'NAME_TAKEN');
      }
      const kind = body?.kind as ProductKind;
      const product = this.addProduct(newProduct, {
        kind,
        nameAr: String(body?.nameAr),
        gameAmount: (body?.gameAmount as number | null | undefined) ?? null,
        officialPriceUsdUnits: (body?.officialPriceUsdUnits as number | null | undefined) ?? null,
        maxQuantity: (body?.maxQuantity as number | undefined) ?? DEFAULT_MAX_QUANTITY[kind],
        regionAr: (body?.regionAr as string | null | undefined) ?? null,
        redemptionAr: (body?.redemptionAr as string | null | undefined) ?? null,
      });
      const game = this.games.find((item) => item.id === newProduct) as StoredGame;
      const missing = this.missing(newProduct);
      if (game.status === 'active' && missing.length > 0) {
        this.products = this.products.filter((item) => item.id !== product.id);
        return error(409, 'CATALOG_INCOMPLETE', { missing });
      }
      return { status: 201, json: this.product(product) };
    }
    const gameId = match(/^\/api\/admin\/catalog\/games\/([^/]+)(?:\/(?:archive|restore))?$/);
    if (gameId) {
      const row = this.games.find((item) => item.id === gameId);
      if (!row) return notFound();
      if (method === 'GET') return { status: 200, json: this.detail(row) };
      if (path.endsWith('/archive')) row.archivedAt = new Date().toISOString();
      else if (path.endsWith('/restore')) row.archivedAt = null;
      else {
        const refusal = this.accentRefusal(body?.accentColor);
        if (refusal) return refusal;
        const before = { ...row };
        Object.assign(row, this.gameValues(body));
        if (body?.status) row.status = body.status as StoredGame['status'];
        const missing = this.missing(row.id);
        if (row.status === 'active' && missing.length > 0) {
          Object.assign(row, before);
          return error(409, 'CATALOG_INCOMPLETE', { missing });
        }
      }
      row.updatedAt = new Date().toISOString();
      return { status: 200, json: this.detail(row) };
    }

    // Fields and products -------------------------------------------------------------------------
    const fieldId = match(/^\/api\/admin\/catalog\/fields\/([^/]+)(?:\/(?:archive|restore))?$/);
    if (fieldId) {
      const row = this.fields.find((item) => item.id === fieldId);
      if (!row) return notFound();
      const before = { ...row };
      if (path.endsWith('/archive')) row.archivedAt = new Date().toISOString();
      else if (path.endsWith('/restore')) row.archivedAt = null;
      else Object.assign(row, body);
      const game = this.games.find((item) => item.id === row.gameId) as StoredGame;
      const missing = this.missing(row.gameId);
      if (game.status === 'active' && missing.length > 0) {
        Object.assign(row, before);
        return error(409, 'CATALOG_INCOMPLETE', { missing });
      }
      return { status: 200, json: row };
    }
    const productId = match(/^\/api\/admin\/catalog\/products\/([^/]+)(?:\/(?:archive|restore))?$/);
    if (productId) {
      const row = this.products.find((item) => item.id === productId);
      if (!row) return notFound();
      if (path.endsWith('/archive')) row.archivedAt = new Date().toISOString();
      else if (path.endsWith('/restore')) {
        row.archivedAt = null;
        row.sortOrder = this.products.filter(
          (item) => item.gameId === row.gameId && !item.archivedAt,
        ).length;
      } else Object.assign(row, body);
      return { status: 200, json: this.product(row) };
    }

    // Pricing -------------------------------------------------------------------------------------
    if (key === 'GET /api/admin/pricing/rules') {
      return { status: 200, json: this.rules.map((row) => this.rule(row)) };
    }
    if (key === 'PUT /api/admin/pricing/rules') {
      if (this.reauthenticationRequired()) return error(403, 'REAUTHENTICATION_REQUIRED');
      const scope = body?.scope as MarginScope;
      const targetId = (body?.targetId as string | null | undefined) ?? null;
      const target = this.target(scope, targetId);
      if (!target || target.archived) return notFound();
      const values = {
        percentBp: Number(body?.percentBp),
        fixedUsdUnits: Number(body?.fixedUsdUnits),
        minMarginUsdUnits: Number(body?.minMarginUsdUnits),
      };
      let row = this.rules.find((item) => item.scope === scope && item.targetId === targetId);
      if (row) Object.assign(row, values, { updatedAt: new Date().toISOString() });
      else {
        row = { id: nextId(), scope, targetId, ...values, updatedAt: new Date().toISOString() };
        this.rules.push(row);
      }
      this.onRulesChanged();
      return { status: 200, json: this.rule(row) };
    }
    const ruleId = match(/^\/api\/admin\/pricing\/rules\/([^/]+)\/archive$/);
    if (ruleId && method === 'POST') {
      if (this.reauthenticationRequired()) return error(403, 'REAUTHENTICATION_REQUIRED');
      const row = this.rules.find((item) => item.id === ruleId);
      if (!row) return notFound();
      if (row.scope === 'global') return error(409, 'GLOBAL_RULE_REQUIRED');
      this.rules = this.rules.filter((item) => item.id !== ruleId);
      this.onRulesChanged();
      return { status: 204 };
    }
    if (key === 'POST /api/admin/pricing/preview') {
      const request = body as {
        target: { scope: MarginScope; targetId?: string | null };
        costUsdUnits: number;
        values?: MarginRuleValues;
      };
      const target = this.target(request.target.scope, request.target.targetId ?? null);
      if (!target) return notFound();
      const found = request.values ? null : resolveMarginRule(this.rules, target.path);
      const rule = request.values ?? (found as StoredRule);
      const price = priceFromCost(request.costUsdUnits, rule);
      const rate = this.rate();
      return {
        status: 200,
        json: {
          rule: {
            percentBp: rule.percentBp,
            fixedUsdUnits: rule.fixedUsdUnits,
            minMarginUsdUnits: rule.minMarginUsdUnits,
          },
          ruleScope: found?.scope ?? null,
          ruleId: found?.id ?? null,
          costUsdUnits: request.costUsdUnits,
          priceUsdUnits: price,
          marginUsdUnits: price - request.costUsdUnits,
          marginBp: marginBasisPoints(price, request.costUsdUnits),
          priceSypUnits: rate
            ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits)
            : null,
          rate: rate?.sypPerUsd ?? null,
          officialPriceUsdUnits: target.official,
          savings: savings(price, target.official),
        },
      };
    }
    return null;
  }

  /** Rule CT6: at least 3:1 against the dark surface. */
  private accentRefusal(accent: unknown): Answer | null {
    if (typeof accent !== 'string') return null;
    const ratio = contrastRatio(accent, ACCENT_DARK_SURFACE);
    return ratio < ACCENT_MIN_CONTRAST ? error(400, 'ACCENT_CONTRAST_TOO_LOW', { ratio }) : null;
  }

  /** The game values a create or update sends; absent keys stay as they are. */
  private gameValues(body: Body): Partial<StoredGame> {
    const values: Partial<StoredGame> = {};
    for (const name of [
      'categoryId',
      'nameAr',
      'nameEn',
      'coverFileId',
      'idGuideFileId',
      'accentColor',
      'regionNotesAr',
    ] as const) {
      if (body && name in body) (values as Record<string, unknown>)[name] = body[name] ?? null;
    }
    return values;
  }
}
