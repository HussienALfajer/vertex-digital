import {
  type ActivateAllResult,
  type CategoryImportResult,
  categoryStandings,
  type ImportDraft,
  type ImportDraftPack,
  missingForActivation,
  type NearbySupplierOrders,
  type PlatformStatus,
  type ProductKind,
  parseGameAmount,
  priceFromCost,
  proposeOptionMap,
  ROOT_PRICE_LIST_IDS,
  type SupplierCall,
  type SupplierCategoryNode,
  type SupplierCategoryState,
  type SupplierCode,
  type SupplierConnectionTest,
  type SupplierOrder,
  type SupplierTransaction,
  suggestGameAmounts,
  suggestInputFields,
  suggestProductName,
  unmappedOptions,
} from '@vertex-digital/contracts';
import { type Answer, type CatalogMock, nextId } from './catalog-mock';
import type { CategoryReader, StoredOffer, SuppliersMock } from './suppliers-mock';

/*
 * The supplier catalog panel of S16 (SC4–SC14, IM1–IM3, SF3–SF5) as the panel sees it: the fake's
 * category tree with our links and ignore states on the contracts' `categoryStandings`, the import
 * and link drafts on `suggestInputFields`, `suggestProductName` and `suggestGameAmounts`, all-or-
 * nothing imports and links with per-row refusals, "تفعيل الكل", the statement and the platform
 * status. A test scripts the statement (`statementOrders`, `transactions`), the nearby orders
 * (`nearby`), a pack added to a category (`addOffer`, as `--add-offer`) and a failing image
 * download (`failImage`).
 */

type Body = Record<string, unknown> | null;

interface StoredCategory {
  supplierCode: SupplierCode;
  categoryId: string;
  /** S19: the supplier's note (FazerCards' region text). */
  note?: string;
  parentCategoryId: string | null;
  name: string;
  kind: ProductKind | null;
  productCount: number | null;
  inStockCount: number | null;
  hasImage: boolean;
  gameId: string | null;
  ignoredAt: string | null;
  missingSince: string | null;
  lastSeenAt: string;
}

/** The fake's tree (`packages/suppliers/src/fake/adapter.ts`). */
const FAKE_TREE: [string, string | null, string, ProductKind][] = [
  ['fake-pubg', null, 'PUBG Mobile', 'direct'],
  ['fake-pubg-global', 'fake-pubg', 'Global', 'direct'],
  ['fake-pubg-mena', 'fake-pubg', 'MENA', 'direct'],
  ['fake-ff', null, 'Free Fire', 'direct'],
  ['fake-ff-auto', 'fake-ff', 'Auto', 'direct'],
  ['fake-gift', null, 'Gift cards', 'code'],
  ['fake-itunes', 'fake-gift', 'iTunes', 'code'],
  ['fake-ml', null, 'Mobile Legends', 'direct'],
  ['fake-gi', null, 'Genshin Impact', 'direct'],
];

/** Rule SC14: the store category of a node's kind. */
const STORE_CATEGORY: Record<ProductKind, string> = { direct: 'games', code: 'gift-cards' };

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const notFound = () => error(404, 'NOT_FOUND');

export class SupplierCatalogMock implements CategoryReader {
  categories: StoredCategory[] = FAKE_TREE.map(([categoryId, parent, name, kind]) => ({
    supplierCode: 'fake',
    categoryId,
    parentCategoryId: parent,
    name,
    kind,
    productCount: null,
    inStockCount: null,
    hasImage: true,
    // S19: a supplier's note on a category, as FazerCards writes them.
    ...(categoryId === 'fake-ff-auto' && {
      note: 'Region: MENA\nDiamonds are delivered automatically after the order is placed.',
    }),
    gameId: null,
    ignoredAt: null,
    missingSince: null,
    lastSeenAt: new Date().toISOString(),
  }));
  /** SF3: the fake's order history and wallet movements, newest first. */
  statementOrders: SupplierOrder[] = [];
  transactions: SupplierTransaction[] = [];
  /** S18 FK3: the recorded calls a test scripts for the health tab, newest first. */
  calls: SupplierCall[] = [];
  /** S18 CS1: the next connection test's answer. */
  connectionTest: Omit<SupplierConnectionTest, 'testedAt'> = {
    ok: true,
    latencyMs: 84,
    balance: { currency: 'USD', amountUnits: 125_750_000 },
    failureKind: null,
    httpStatus: null,
    supplierCode: null,
  };
  /** SF4: what the next nearby read answers. */
  nearby: NearbySupplierOrders = { items: [], complete: true };
  /** IM2: the next supplier image download fails (`IMAGE_FETCH_FAILED`). */
  failImage = false;
  platform: PlatformStatus = {
    status: 'operational',
    catalogUpdatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    checkedAt: new Date().toISOString(),
  };

  constructor(
    private readonly suppliers: SuppliersMock,
    private readonly catalog: CatalogMock,
  ) {
    suppliers.categories = this;
  }

  // CategoryReader ------------------------------------------------------------------------------

  path(code: SupplierCode, categoryId: string | null): string[] {
    const names: string[] = [];
    let row = categoryId ? this.find(code, categoryId) : undefined;
    while (row) {
      names.unshift(row.name);
      row = row.parentCategoryId ? this.find(code, row.parentCategoryId) : undefined;
    }
    return names;
  }

  subtree(code: SupplierCode, categoryId: string): Set<string> {
    const ids = new Set([categoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of this.categories) {
        if (
          row.supplierCode === code &&
          row.parentCategoryId &&
          ids.has(row.parentCategoryId) &&
          !ids.has(row.categoryId)
        ) {
          ids.add(row.categoryId);
          grew = true;
        }
      }
    }
    return ids;
  }

  newOfferCount(code: SupplierCode): number {
    const standings = this.standings(code);
    const roots = this.categories.filter(
      (row) => row.supplierCode === code && row.parentCategoryId === null,
    );
    return roots.reduce((sum, row) => sum + (standings.get(row.categoryId)?.newPacks ?? 0), 0);
  }

  // Test scripts --------------------------------------------------------------------------------

  /** `supplier:fake --add-offer <category> <name> <usd>`, read by the next sync. */
  addOffer(categoryId: string, name: string, usd: number): StoredOffer {
    const category = this.find('fake', categoryId);
    if (!category) throw new Error(`No category ${categoryId}`);
    const now = new Date().toISOString();
    const offer: StoredOffer = {
      id: nextId(),
      supplierCode: 'fake',
      offerId: `fake-added-${this.suppliers.offers.length}`,
      name,
      groupName: this.path('fake', categoryId)[0] ?? null,
      kind: category.kind,
      requiredFields: category.kind === 'direct' ? ['playerId'] : [],
      costUsdUnits: Math.round(usd * 1_000_000),
      costRaw: null,
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
      missingSince: null,
      categoryId,
      stock: null,
      originalCostUsdUnits: null,
      fieldSpecs:
        category.kind === 'direct' ? [{ key: 'playerId', label: 'Player ID', type: 'text' }] : [],
      unsupportedReason: null,
      ignoredAt: null,
      discountBp: null,
    };
    this.suppliers.offers.push(offer);
    return offer;
  }

  /** An offer the store cannot order yet (two fields, rule SC3). */
  addUnsupported(categoryId: string, name: string, usd: number): StoredOffer {
    const offer = this.addOffer(categoryId, name, usd);
    offer.unsupportedReason = 'fields_unsupported';
    offer.fieldSpecs = [
      { key: 'playerId', label: 'Player ID', type: 'text' },
      {
        key: 'server',
        label: 'Server',
        type: 'select',
        options: [
          { label: 'Asia', value: 'asia' },
          { label: 'Europe', value: 'eu' },
        ],
      },
    ];
    offer.requiredFields = ['playerId', 'server'];
    return offer;
  }

  /** Links a node to a game, as an earlier import did. */
  link(categoryId: string, gameId: string): void {
    (this.find('fake', categoryId) as StoredCategory).gameId = gameId;
  }

  // The API -------------------------------------------------------------------------------------

  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const match = (pattern: RegExp) => path.match(pattern);

    // SF4: the nearby supplier orders of an attempt, as the test scripted them.
    if (
      method === 'GET' &&
      match(/^\/api\/admin\/orders\/[^/]+\/attempts\/[^/]+\/supplier-orders$/)
    ) {
      return { status: 200, json: this.nearby };
    }

    const gamePath = match(
      /^\/api\/admin\/catalog\/games\/([^/]+)\/(activate-all|cover\/from-supplier|supplier-categories)$/,
    );
    if (gamePath) {
      const game = this.catalog.games.find((item) => item.id === gamePath[1]);
      if (!game) return notFound();
      if (gamePath[2] === 'supplier-categories' && method === 'GET') {
        const rows = this.categories.filter((row) => row.gameId === game.id);
        return { status: 200, json: rows.map((row) => this.node(row)) };
      }
      if (gamePath[2] === 'activate-all' && method === 'POST') return this.activateAll(game.id);
      if (gamePath[2] === 'cover/from-supplier' && method === 'POST') {
        const row = this.find(body?.supplier as SupplierCode, String(body?.categoryId));
        if (!row || row.gameId !== game.id) return notFound();
        if (this.failImage) {
          this.failImage = false;
          return error(502, 'IMAGE_FETCH_FAILED');
        }
        game.coverFileId = this.catalog.upload().id;
        return { status: 200, json: this.catalog.detail(game) };
      }
    }

    // S18: the packs an offer may be linked to: its category game's, its amount first, then `q`.
    const candidates = match(/^\/api\/admin\/suppliers\/offers\/([^/]+)\/link-candidates$/);
    if (candidates && method === 'GET') {
      const offer = this.suppliers.offers.find((item) => item.id === candidates[1]);
      if (!offer) return notFound();
      const gameId = offer.categoryId
        ? (this.standings(offer.supplierCode).get(offer.categoryId)?.effectiveGameId ?? null)
        : null;
      const amount = parseGameAmount(offer.name.split(' · ').at(-1) ?? offer.name);
      const q = url.searchParams.get('q');
      const live = this.catalog.products.filter(
        (product) =>
          product.archivedAt === null && (offer.kind === null || product.kind === offer.kind),
      );
      const ranked = [
        ...live
          .filter((product) => product.gameId === gameId)
          .map((product) => ({
            product,
            reason: amount !== null && product.gameAmount === amount ? 'amount' : 'game',
          }))
          .sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'amount' ? -1 : 1)),
        ...(q
          ? live
              .filter((product) => product.gameId !== gameId && product.nameAr.includes(q))
              .map((product) => ({ product, reason: 'search' }))
          : []),
      ].slice(0, 20);
      return {
        status: 200,
        json: ranked.map(({ product, reason }) => ({
          productId: product.id,
          productNameAr: product.nameAr,
          gameId: product.gameId,
          gameNameAr: this.catalog.games.find((game) => game.id === product.gameId)?.nameAr ?? '',
          kind: product.kind,
          routedBySupplier: this.suppliers.routes.some(
            (route) =>
              route.productId === product.id &&
              !route.archivedAt &&
              this.suppliers.offers.find((item) => item.id === route.offerId)?.supplierCode ===
                offer.supplierCode,
          ),
          reason,
        })),
      };
    }

    const test = match(/^\/api\/admin\/suppliers\/([^/]+)\/test$/);
    if (test && method === 'POST') {
      return {
        status: 200,
        json: { ...this.connectionTest, testedAt: new Date().toISOString() },
      };
    }

    const calls = match(/^\/api\/admin\/suppliers\/([^/]+)\/calls$/);
    if (calls && method === 'GET') {
      const result = url.searchParams.get('result');
      const items = this.calls.filter((call) => !result || call.result === result);
      return {
        status: 200,
        json: { items: items.slice(0, 50), total: items.length, page: 1, pageSize: 50 },
      };
    }

    const offerIgnore = match(/^\/api\/admin\/suppliers\/offers\/([^/]+)\/(ignore|unignore)$/);
    if (offerIgnore && method === 'POST') {
      const offer = this.suppliers.offers.find((item) => item.id === offerIgnore[1]);
      if (!offer) return notFound();
      if (offerIgnore[2] === 'ignore') {
        if (this.mapped(offer)) return error(409, 'OFFER_ALREADY_MAPPED');
        offer.ignoredAt = offer.ignoredAt ?? new Date().toISOString();
      } else {
        offer.ignoredAt = null;
      }
      return { status: 200, json: this.suppliers.offer(offer) };
    }

    const platform = match(/^\/api\/admin\/suppliers\/([^/]+)\/platform-status$/);
    if (platform && method === 'GET') {
      if (platform[1] !== 'fake' && platform[1] !== 'wdgzone') {
        return error(409, 'CAPABILITY_UNSUPPORTED');
      }
      return { status: 200, json: this.platform };
    }

    const statement = match(/^\/api\/admin\/suppliers\/([^/]+)\/statement\/(orders|transactions)$/);
    if (statement && method === 'GET') {
      if (statement[1] !== 'fake') return error(409, 'CAPABILITY_UNSUPPORTED');
      const page = Number(url.searchParams.get('page') ?? 1);
      const items = statement[2] === 'orders' ? this.statementOrders : this.transactions;
      const size = 50;
      return {
        status: 200,
        json: {
          items: items.slice((page - 1) * size, page * size),
          page,
          hasMore: items.length > page * size,
        },
      };
    }

    const tree = match(/^\/api\/admin\/suppliers\/([^/]+)\/categories$/);
    if (tree && method === 'GET') {
      const code = tree[1] as SupplierCode;
      if (code !== 'fake') return error(409, 'CAPABILITY_UNSUPPORTED');
      return { status: 200, json: this.list(code, url) };
    }

    // S18: one node for the category page.
    const one = match(/^\/api\/admin\/suppliers\/([^/]+)\/categories\/([^/]+)$/);
    if (one && method === 'GET') {
      const row = this.find(one[1] as SupplierCode, decodeURIComponent(one[2] as string));
      return row ? { status: 200, json: this.node(row) } : notFound();
    }

    const node = match(
      /^\/api\/admin\/suppliers\/([^/]+)\/categories\/([^/]+)\/(image|import-draft|import|link|unlink|ignore|unignore)$/,
    );
    if (node) {
      const code = node[1] as SupplierCode;
      const row = this.find(code, decodeURIComponent(node[2] as string));
      if (!row) return notFound();
      const action = node[3];
      if (action === 'image' && method === 'GET') {
        return row.hasImage ? { status: 200, image: true } : notFound();
      }
      if (action === 'import-draft' && method === 'GET') {
        if (row.missingSince) return error(409, 'CATEGORY_MISSING');
        return { status: 200, json: this.draft(row, url.searchParams.get('gameId')) };
      }
      if (action === 'import' && method === 'POST') return this.import(row, body);
      if (action === 'link' && method === 'POST') return this.linkRows(row, body);
      if (method === 'POST') {
        if (action === 'unlink') row.gameId = null;
        if (action === 'ignore') row.ignoredAt = row.ignoredAt ?? new Date().toISOString();
        if (action === 'unignore') row.ignoredAt = null;
        return { status: 200, json: this.node(row) };
      }
    }
    return null;
  }

  // Helpers -------------------------------------------------------------------------------------

  private find(code: SupplierCode, categoryId: string): StoredCategory | undefined {
    return this.categories.find(
      (row) => row.supplierCode === code && row.categoryId === categoryId,
    );
  }

  private offersOf(code: SupplierCode): StoredOffer[] {
    return this.suppliers.offers.filter((offer) => offer.supplierCode === code);
  }

  private mapped(offer: StoredOffer): boolean {
    return this.suppliers.routes.some((route) => route.offerId === offer.id && !route.archivedAt);
  }

  private standings(code: SupplierCode) {
    return categoryStandings(
      this.categories
        .filter((row) => row.supplierCode === code)
        .map((row) => ({
          categoryId: row.categoryId,
          parentCategoryId: row.parentCategoryId,
          gameId: row.gameId,
          ignored: row.ignoredAt !== null,
        })),
      this.offersOf(code).map((offer) => ({
        categoryId: offer.categoryId,
        mapped: this.mapped(offer),
        ignored: offer.ignoredAt !== null,
        supported: offer.unsupportedReason === null,
        inStock: offer.inStock,
        missing: offer.missingSince !== null,
      })),
    );
  }

  private node(row: StoredCategory): SupplierCategoryNode {
    const standing = this.standings(row.supplierCode).get(row.categoryId);
    if (!standing) throw new Error(`No standing for ${row.categoryId}`);
    const gameId = standing.effectiveGameId;
    const game = gameId ? this.catalog.games.find((item) => item.id === gameId) : undefined;
    const offers = this.offersOf(row.supplierCode).filter(
      (offer) =>
        offer.categoryId !== null &&
        this.subtree(row.supplierCode, row.categoryId).has(offer.categoryId),
    );
    return {
      supplierCode: row.supplierCode,
      categoryId: row.categoryId,
      parentCategoryId: row.parentCategoryId,
      name: row.name,
      path: this.path(row.supplierCode, row.parentCategoryId),
      kind: row.kind,
      productCount: row.productCount ?? offers.length,
      inStockCount: row.inStockCount ?? offers.filter((offer) => offer.inStock).length,
      hasImage: row.hasImage,
      note: row.note ?? null,
      childCount: this.categories.filter(
        (item) =>
          item.supplierCode === row.supplierCode && item.parentCategoryId === row.categoryId,
      ).length,
      counts: {
        mapped: standing.mapped,
        unmapped: standing.unmapped,
        ignored: standing.ignored,
        unsupported: standing.unsupported,
        newPacks: standing.newPacks,
      },
      state: standing.state,
      game: game ? { id: game.id, nameAr: game.nameAr } : null,
      linkedHere: row.gameId !== null,
      ignoredAt: row.ignoredAt,
      missingSince: row.missingSince,
      lastSeenAt: row.lastSeenAt,
    };
  }

  /** Rule SC4: a level (roots without `parentId`), or with `q` or `state` any depth. */
  private list(code: SupplierCode, url: URL) {
    const parentId = url.searchParams.get('parentId');
    const q = url.searchParams.get('q')?.toLowerCase();
    const state = url.searchParams.get('state') as SupplierCategoryState | null;
    const kind = url.searchParams.get('kind');
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = Number(url.searchParams.get('pageSize') ?? 100);
    const standings = this.standings(code);
    const anyDepth = q !== undefined || state !== null;
    const rows = this.categories
      .filter((row) => row.supplierCode === code)
      .filter((row) => anyDepth || row.parentCategoryId === parentId)
      .filter((row) => !kind || row.kind === kind)
      .filter((row) => !state || standings.get(row.categoryId)?.state === state)
      .filter((row) => !q || row.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      items: rows.slice((page - 1) * size, page * size).map((row) => this.node(row)),
      total: rows.length,
      page,
      pageSize: size,
    };
  }

  /** The node's packs with refusals, suggestions and price previews (SC7, SC8, SC12, SC13). */
  private draft(row: StoredCategory, gameId: string | null): ImportDraft {
    const subtree = this.subtree(row.supplierCode, row.categoryId);
    const offers = this.offersOf(row.supplierCode).filter(
      (offer) => offer.categoryId !== null && subtree.has(offer.categoryId),
    );
    const leaves = new Set(offers.map((offer) => offer.categoryId));
    const game = gameId ? this.catalog.games.find((item) => item.id === gameId) : undefined;
    const products = game
      ? this.catalog.products.filter((item) => item.gameId === game.id && !item.archivedAt)
      : [];
    const global = this.catalog.ruleFor(ROOT_PRICE_LIST_IDS.retail, {});
    const amounts = suggestGameAmounts(offers.map((offer) => offer.name));
    const packs: ImportDraftPack[] = offers.map((offer, index) => {
      const leaf = this.find(row.supplierCode, offer.categoryId as string) as StoredCategory;
      const view = this.suppliers.offer(offer);
      const amount = amounts[index] ?? null;
      // The API also asks that the product's routes deliver the pack's unit (A05-3); the mock
      // matches by amount alone.
      const match = products.find(
        (product) =>
          (amount !== null && product.gameAmount === amount) || product.nameAr === offer.name,
      );
      return {
        offerId: offer.id,
        supplierOfferId: offer.offerId,
        name: offer.name,
        leafCategoryId: leaf.categoryId,
        leafName: leaf.name,
        kind: offer.kind,
        costUsdUnits: offer.costUsdUnits,
        originalCostUsdUnits: offer.originalCostUsdUnits,
        discountPercent: view.discountPercent,
        stock: offer.stock,
        stockLevel: view.stockLevel,
        requiredFields: offer.requiredFields,
        fieldSpecs: offer.fieldSpecs,
        refusal: offer.unsupportedReason
          ? 'OFFER_UNSUPPORTED'
          : offer.ignoredAt
            ? 'OFFER_IGNORED'
            : this.mapped(offer)
              ? 'OFFER_ALREADY_MAPPED'
              : offer.missingSince
                ? 'OFFER_MISSING'
                : null,
        suggestedNameAr: suggestProductName(offer.name, leaf.name, leaves.size > 1),
        suggestedGameAmount: amount,
        pricePreviewUsdUnits:
          offer.costUsdUnits === null ? null : priceFromCost(offer.costUsdUnits, global),
        match: match ? { productId: match.id, nameAr: match.nameAr } : null,
      };
    });
    // As the API: the fields of the packs that can be chosen.
    const usable = new Set(
      packs.filter((pack) => pack.refusal === null).map((pack) => pack.offerId),
    );
    const specs = offers
      .filter((offer) => usable.has(offer.id))
      .flatMap((offer) => offer.fieldSpecs ?? []);
    const suggested = suggestInputFields(specs);
    const kind = row.kind;
    const category = this.catalog.categories.find(
      (item) => item.slug === STORE_CATEGORY[kind ?? 'direct'],
    );
    const root = this.path(row.supplierCode, row.categoryId)[0] ?? row.name;
    const slug = root
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const fields = game
      ? this.catalog.fields.filter((item) => item.gameId === game.id && !item.archivedAt)
      : [];
    const fieldMap = game
      ? Object.fromEntries(
          Object.entries(suggested.fieldMap).flatMap(([supplierKey, key]) => {
            // As the API: the same key, underscores aside.
            const same = fields.find(
              (field) => field.key.replaceAll('_', '') === key.replaceAll('_', ''),
            );
            return same ? [[supplierKey, same.key]] : [];
          }),
        )
      : suggested.fieldMap;
    const specOf = (key: string) => specs.find((item) => item.key === key);
    // S16 MF3: a link proposes the game's options onto the supplier's; an import sends the first
    // pack's values.
    const optionMap = game
      ? Object.fromEntries(
          Object.entries(fieldMap).flatMap(([supplierKey, key]) => {
            const spec = specOf(supplierKey);
            const field = fields.find((item) => item.key === key);
            if (spec?.type !== 'select' || !field?.options) return [];
            return [[supplierKey, proposeOptionMap(field.options, spec.options ?? [])]];
          }),
        )
      : suggested.optionMap;
    const selects = game
      ? this.suppliers.selectsOf(game.id)
      : Object.fromEntries(
          suggested.fields.flatMap((field) =>
            field.options ? [[field.key, field.options.map((option) => option.value)]] : [],
          ),
        );
    for (const pack of packs) {
      if (pack.refusal === null) {
        const gaps = unmappedOptions(pack.fieldSpecs, fieldMap, optionMap, selects);
        if (gaps.length > 0) pack.refusal = 'FIELD_OPTIONS_DIFFER';
      }
    }
    return {
      category: this.node(row),
      kind,
      game: { nameAr: root, nameEn: root, slug, categoryId: category?.id ?? null },
      linkGame: game
        ? {
            id: game.id,
            nameAr: game.nameAr,
            fields: fields.map((field) => ({
              key: field.key,
              labelAr: field.labelAr,
              type: field.type,
              options: field.options,
            })),
          }
        : null,
      fields: suggested.fields.map((field) => {
        const spec = specs.find((item) => item.key === field.supplierKey);
        return {
          ...field,
          supplierLabel: spec?.label ?? field.supplierKey,
          supplierType: spec?.type ?? 'text',
          supplierOptions: spec?.options ?? null,
        };
      }),
      fieldMap,
      optionMap,
      packs,
    };
  }

  /** Per-row refusals of rule SC7's packs, in the request's order. */
  private rowErrors(
    row: StoredCategory,
    rows: { offerId: string; nameAr?: string; productId?: string }[],
    taken: string[],
    maps: {
      fieldMap: Record<string, string>;
      optionMap: Record<string, Record<string, string>>;
      selects: Record<string, string[]>;
    },
  ) {
    const subtree = this.subtree(row.supplierCode, row.categoryId);
    return rows.flatMap((item, index) => {
      const offer = this.suppliers.offers.find((entry) => entry.id === item.offerId);
      if (!offer || offer.categoryId === null || !subtree.has(offer.categoryId)) {
        return [{ index, code: 'NOT_FOUND' }];
      }
      if (offer.unsupportedReason) return [{ index, code: 'OFFER_UNSUPPORTED' }];
      if (offer.ignoredAt) return [{ index, code: 'OFFER_IGNORED' }];
      if (this.mapped(offer)) return [{ index, code: 'OFFER_ALREADY_MAPPED' }];
      const gaps = unmappedOptions(offer.fieldSpecs, maps.fieldMap, maps.optionMap, maps.selects);
      if (gaps.length > 0) return [{ index, code: 'FIELD_OPTIONS_DIFFER', fields: gaps }];
      if (item.nameAr !== undefined && taken.includes(item.nameAr)) {
        return [{ index, code: 'NAME_TAKEN' }];
      }
      return [];
    });
  }

  private linked(row: StoredCategory): string | null {
    const ids = this.subtree(row.supplierCode, row.categoryId);
    const lineage = new Set<string>();
    let at: StoredCategory | undefined = row;
    while (at) {
      lineage.add(at.categoryId);
      at = at.parentCategoryId ? this.find(row.supplierCode, at.parentCategoryId) : undefined;
    }
    const other = this.categories.find(
      (item) =>
        item.supplierCode === row.supplierCode &&
        item.gameId !== null &&
        (ids.has(item.categoryId) || lineage.has(item.categoryId)),
    );
    return other?.gameId ?? null;
  }

  /** Rule SC7: all or nothing, a paused game with its fields, packs, routes and first prices. */
  private import(row: StoredCategory, body: Body): Answer {
    if (row.missingSince) return error(409, 'CATEGORY_MISSING');
    const linkedGame = this.linked(row);
    if (linkedGame) return error(409, 'CATEGORY_LINKED', { gameId: linkedGame });
    const game = body?.game as { slug: string; categoryId: string; nameAr: string; nameEn: string };
    const cover = body?.cover as { supplierImage?: true; coverFileId?: string };
    const fields = (body?.fields ?? []) as {
      key: string;
      labelAr: string;
      type: 'digits' | 'text' | 'select';
      required: boolean;
      minLength?: number | null;
      maxLength?: number | null;
      options?: { value: string; labelAr: string }[];
    }[];
    const fieldMap = (body?.fieldMap ?? {}) as Record<string, string>;
    const optionMap = (body?.optionMap ?? {}) as Record<string, Record<string, string>>;
    const rows = (body?.rows ?? []) as { offerId: string; nameAr: string; gameAmount?: number }[];
    if (this.catalog.games.some((item) => item.slug === game.slug)) {
      return error(409, 'SLUG_TAKEN');
    }
    const selects = Object.fromEntries(
      fields.flatMap((field) =>
        field.options ? [[field.key, field.options.map((option) => option.value)]] : [],
      ),
    );
    const errors = this.rowErrors(row, rows, [], { fieldMap, optionMap, selects });
    const [first] = errors;
    if (first) return error(first.code === 'NOT_FOUND' ? 404 : 409, first.code, { rows: errors });
    if (cover.supplierImage && this.failImage) {
      this.failImage = false;
      return error(502, 'IMAGE_FETCH_FAILED');
    }
    const category = this.catalog.categories.find((item) => item.id === game.categoryId);
    if (!category) return error(400, 'VALIDATION_FAILED');
    const created = this.catalog.addGame({
      categorySlug: category.slug,
      slug: game.slug,
      nameAr: game.nameAr,
      nameEn: game.nameEn,
      status: 'paused',
      cover: !!cover.supplierImage,
    });
    if (cover.coverFileId) created.coverFileId = cover.coverFileId;
    for (const field of fields) {
      this.catalog.addField(created.id, {
        ...field,
        minLength: field.minLength ?? null,
        maxLength: field.maxLength ?? null,
        options: field.options ?? null,
      });
    }
    const products = this.createRows(created.id, rows, fieldMap, optionMap);
    row.gameId = created.id;
    const result: CategoryImportResult = { gameId: created.id, products };
    return { status: 201, json: result };
  }

  /** Rule SC8: routes to existing products and new paused packs, all or nothing. */
  private linkRows(row: StoredCategory, body: Body): Answer {
    if (row.missingSince) return error(409, 'CATEGORY_MISSING');
    const gameId = String(body?.gameId);
    const game = this.catalog.games.find((item) => item.id === gameId);
    if (!game) return notFound();
    const linkedGame = this.linked(row);
    if (linkedGame && linkedGame !== gameId) {
      return error(409, 'CATEGORY_LINKED', { gameId: linkedGame });
    }
    const fieldMap = (body?.fieldMap ?? {}) as Record<string, string>;
    const optionMap = (body?.optionMap ?? {}) as Record<string, Record<string, string>>;
    const rows = (body?.rows ?? []) as {
      offerId: string;
      productId?: string;
      priceBasis?: boolean;
      nameAr?: string;
      gameAmount?: number;
    }[];
    const taken = this.catalog.products
      .filter((item) => item.gameId === gameId && !item.archivedAt)
      .map((item) => item.nameAr);
    const errors = this.rowErrors(row, rows, taken, {
      fieldMap,
      optionMap,
      selects: this.suppliers.selectsOf(gameId),
    });
    const [first] = errors;
    if (first) return error(first.code === 'NOT_FOUND' ? 404 : 409, first.code, { rows: errors });
    const products = rows.flatMap((item) => {
      if (!item.productId) return [];
      const product = this.catalog.products.find((entry) => entry.id === item.productId);
      if (!product) return [];
      const route = this.suppliers.addRoute(
        product.id,
        row.supplierCode,
        item.offerId,
        fieldMap,
        1,
        optionMap,
        { priceBasis: item.priceBasis ?? true },
      );
      this.suppliers.reprice([product.id], 'route_change');
      return [
        {
          id: product.id,
          nameAr: product.nameAr,
          routeId: route.id,
          existing: true,
          priceUsdUnits: this.suppliers.currentPrice(product.id)?.priceUsdUnits ?? null,
        },
      ];
    });
    products.push(
      ...this.createRows(
        gameId,
        rows.filter((item) => !item.productId) as { offerId: string; nameAr: string }[],
        fieldMap,
        optionMap,
      ),
    );
    row.gameId = gameId;
    const result: CategoryImportResult = { gameId, products };
    return { status: 201, json: result };
  }

  private createRows(
    gameId: string,
    rows: { offerId: string; nameAr: string; gameAmount?: number }[],
    fieldMap: Record<string, string>,
    optionMap: Record<string, Record<string, string>>,
  ) {
    return rows.map((item) => {
      const offer = this.suppliers.offers.find((entry) => entry.id === item.offerId) as StoredOffer;
      const product = this.catalog.addProduct(gameId, {
        nameAr: item.nameAr,
        kind: offer.kind ?? 'direct',
        gameAmount: item.gameAmount ?? null,
        status: 'paused',
        maxQuantity: offer.kind === 'code' ? 10 : 1,
      });
      const own = <Value>(map: Record<string, Value>) =>
        Object.fromEntries(
          Object.entries(map).filter(([field]) => offer.requiredFields?.includes(field)),
        );
      const route = this.suppliers.addRoute(
        product.id,
        offer.supplierCode,
        offer.id,
        own(fieldMap),
        1,
        own(optionMap),
      );
      this.suppliers.reprice([product.id], 'route_change');
      return {
        id: product.id,
        nameAr: product.nameAr,
        routeId: route.id,
        existing: false,
        priceUsdUnits: this.suppliers.currentPrice(product.id)?.priceUsdUnits ?? null,
      };
    });
  }

  /** Rule SC10: the game when CT3 allows it, and every paused pack that can serve. */
  private activateAll(gameId: string): Answer {
    const game = this.catalog.games.find((item) => item.id === gameId);
    if (!game) return notFound();
    const products = this.catalog.products.filter(
      (item) => item.gameId === gameId && !item.archivedAt,
    );
    const missing = missingForActivation({
      hasCover: game.coverFileId !== null,
      hasDirectProduct: products.some((item) => item.kind === 'direct'),
      hasRequiredField: this.catalog.fields.some(
        (item) => item.gameId === gameId && !item.archivedAt && item.required,
      ),
    });
    if (missing.length > 0) return error(409, 'CATALOG_INCOMPLETE', { missing });
    const result: ActivateAllResult = {
      gameId,
      gameActivated: game.status === 'paused',
      activated: [],
      skipped: [],
    };
    game.status = 'active';
    for (const product of products.filter((item) => item.status === 'paused')) {
      const price = this.suppliers.currentPrice(product.id);
      const reason = this.suppliers.openReview(product.id)
        ? ('review_pending' as const)
        : price === null
          ? ('no_price' as const)
          : this.suppliers.usable(product.id).length === 0
            ? ('no_route' as const)
            : null;
      if (reason) {
        result.skipped.push({ productId: product.id, nameAr: product.nameAr, reason });
      } else {
        product.status = 'active';
        result.activated.push({ productId: product.id, nameAr: product.nameAr });
      }
    }
    return { status: 200, json: result };
  }
}
