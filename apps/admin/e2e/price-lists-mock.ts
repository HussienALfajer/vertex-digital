import {
  type AccountType,
  type AdminCustomer,
  effectivePriceListId,
  type FixedPrice,
  type ListPriceCell,
  listChain,
  listPrice,
  marginBasisPoints,
  matrixCellWarnings,
  PRICE_LIST_MAX_DEPTH,
  PRICE_LISTS_MAX_CUSTOM,
  type PriceList,
  type PriceListKind,
  type PriceMatrix,
  type PriceMatrixCell,
  priceKindOf,
  priceListNameSchema,
  priceMatrixQuerySchema,
  ROOT_PRICE_LIST_IDS,
  resolveListEntry,
  selectMatrixRows,
} from '@vertex-digital/contracts';
import { type Answer, type CatalogMock, nextId } from './catalog-mock';

/*
 * The price lists of S20 as the panel sees them, built on the catalog mock's products, rules and
 * prices: the lists (LS1–LS6), fixed prices (LP1), the matrix and an account's list (AT2), every
 * price computed now with the contracts' `resolveListEntry` and `listPrice`, capped at retail.
 */

type Body = Record<string, unknown> | null;

interface StoredList {
  id: string;
  kind: PriceListKind;
  name: string;
  parentListId: string | null;
  archivedAt: string | null;
  createdAt: string;
}

interface StoredFixed {
  id: string;
  priceListId: string;
  productId: string;
  priceUsdUnits: number;
  createdAt: string;
}

const NOW = '2026-10-20T09:00:00.000Z';

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

export class PriceListsMock {
  lists: StoredList[] = [
    { id: ROOT_PRICE_LIST_IDS.retail, kind: 'retail', name: 'التجزئة' },
    { id: ROOT_PRICE_LIST_IDS.wholesale, kind: 'wholesale', name: 'الجملة' },
    { id: ROOT_PRICE_LIST_IDS.cost, kind: 'cost', name: 'سعر التكلفة' },
  ].map((list) => ({
    ...(list as Pick<StoredList, 'id' | 'kind' | 'name'>),
    parentListId: null,
    archivedAt: null,
    createdAt: NOW,
  }));
  fixed: StoredFixed[] = [];
  /** AT2: assigned lists by customer id. */
  assigned = new Map<string, string>();
  /** S21 LV6: live merchant levels holding a list, by its id (set per test). */
  levelsOn = new Map<string, number>();
  /** The matrix's estimate of a product with no usable route, by its id (set per test). */
  estimates = new Map<string, NonNullable<PriceMatrix['rows'][number]['estimate']>>();

  constructor(
    private readonly catalog: CatalogMock,
    private readonly reauthenticationRequired: () => boolean,
    /** A customer's name and email, for the list page's accounts. */
    private readonly customer: (id: string) => { name: string; email: string } | null,
  ) {
    catalog.chainOf = (id) => this.chain(id);
  }

  /** Sets the scene: a custom list under wholesale with its own global rule. */
  addList(name: string, parentListId: string, percentBp?: number): StoredList {
    const list: StoredList = {
      id: nextId(),
      kind: 'custom',
      name,
      parentListId,
      archivedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.lists.push(list);
    if (percentBp !== undefined) {
      this.catalog.rules.push({
        id: nextId(),
        priceListId: list.id,
        scope: 'global',
        targetId: null,
        percentBp,
        fixedUsdUnits: 0,
        minMarginUsdUnits: 20_000,
        updatedAt: NOW,
      });
    }
    return list;
  }

  setFixed(priceListId: string, productId: string, priceUsdUnits: number): void {
    this.fixed = this.fixed.filter(
      (row) => !(row.priceListId === priceListId && row.productId === productId),
    );
    this.fixed.push({
      id: nextId(),
      priceListId,
      productId,
      priceUsdUnits,
      createdAt: new Date().toISOString(),
    });
  }

  /** The profile's pricing card (AT1). */
  pricing(customerId: string, accountType: AccountType = 'customer'): AdminCustomer['pricing'] {
    const assignedListId = this.assigned.get(customerId) ?? null;
    const list = this.lists.find(
      (row) =>
        row.id === (assignedListId ?? effectivePriceListId({ accountType, priceListId: null })),
    ) as StoredList;
    return {
      accountType,
      assignedListId,
      effectiveList: { id: list.id, kind: list.kind, name: list.name },
      priceKind: priceKindOf(list.kind),
    };
  }

  /** AT2: an unarchived list, or null for the type's default. */
  assign(customerId: string, priceListId: string | null): Answer | null {
    if (priceListId === null) {
      this.assigned.delete(customerId);
      return null;
    }
    const list = this.lists.find((row) => row.id === priceListId);
    if (!list) return error(404, 'NOT_FOUND');
    if (list.archivedAt) return error(409, 'PRICE_LIST_ARCHIVED');
    this.assigned.set(customerId, priceListId);
    return null;
  }

  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    if (key === 'GET /api/admin/pricing/lists') {
      return { status: 200, json: this.lists.map((row) => this.view(row)) };
    }
    if (key === 'POST /api/admin/pricing/lists') {
      const refused = sensitive();
      if (refused) return refused;
      const name = priceListNameSchema.safeParse(body?.name);
      const parent = this.lists.find((row) => row.id === body?.parentListId);
      if (!name.success || !parent) return error(400, 'VALIDATION_FAILED');
      if (parent.archivedAt) return error(409, 'PRICE_LIST_ARCHIVED');
      if (this.chain(parent.id).length >= PRICE_LIST_MAX_DEPTH) {
        return error(400, 'VALIDATION_FAILED');
      }
      const live = this.lists.filter((row) => !row.archivedAt);
      if (live.filter((row) => row.kind === 'custom').length >= PRICE_LISTS_MAX_CUSTOM) {
        return error(409, 'PRICE_LISTS_LIMIT_REACHED');
      }
      if (live.some((row) => row.name.toLowerCase() === name.data.toLowerCase())) {
        return error(409, 'PRICE_LIST_NAME_TAKEN');
      }
      return { status: 201, json: this.view(this.addList(name.data, parent.id)) };
    }
    const listId = path.match(/^\/api\/admin\/pricing\/lists\/([^/]+)/)?.[1];
    const list = this.lists.find((row) => row.id === listId);
    if (listId && !list) return error(404, 'NOT_FOUND');
    if (list && key === `GET /api/admin/pricing/lists/${list.id}`) {
      const chain = this.chain(list.id).map((id) => this.lists.find((row) => row.id === id));
      return {
        status: 200,
        json: {
          list: this.view(list),
          chain: chain.map((row) => ({
            id: row?.id,
            kind: row?.kind,
            name: row?.name,
          })),
          fixedPrices: this.fixed
            .filter((row) => row.priceListId === list.id)
            .map((row) => this.fixedView(row)),
          accounts: [...this.assigned]
            .filter(([, id]) => id === list.id)
            .map(([id]) => ({ id, accountType: 'customer', ...this.customer(id) })),
        },
      };
    }
    if (list && key === `PATCH /api/admin/pricing/lists/${list.id}`) {
      const refused = sensitive();
      if (refused) return refused;
      const name = priceListNameSchema.safeParse(body?.name);
      if (!name.success) return error(400, 'VALIDATION_FAILED');
      if (list.archivedAt) return error(409, 'PRICE_LIST_ARCHIVED');
      list.name = name.data;
      return { status: 200, json: this.view(list) };
    }
    if (list && key === `POST /api/admin/pricing/lists/${list.id}/archive`) {
      const refused = sensitive();
      if (refused) return refused;
      if (list.kind !== 'custom') return error(400, 'VALIDATION_FAILED');
      const accounts = [...this.assigned.values()].filter((id) => id === list.id).length;
      const children = this.lists.filter(
        (row) => row.parentListId === list.id && !row.archivedAt,
      ).length;
      const levels = this.levelsOn.get(list.id) ?? 0;
      if (accounts > 0 || children > 0 || levels > 0) {
        return error(409, 'PRICE_LIST_IN_USE', { accounts, children, levels });
      }
      list.archivedAt = new Date().toISOString();
      this.fixed = this.fixed.filter((row) => row.priceListId !== list.id);
      return { status: 200, json: this.view(list) };
    }
    const productId = path.match(/\/fixed-prices\/([^/]+)$/)?.[1];
    if (list && productId) {
      const refused = sensitive();
      if (refused) return refused;
      if (list.archivedAt) return error(409, 'PRICE_LIST_ARCHIVED');
      if (!this.catalog.productView(productId)) return error(404, 'NOT_FOUND');
      if (method === 'PUT') {
        this.setFixed(list.id, productId, Number(body?.priceUsdUnits));
        const row = this.fixed.find(
          (item) => item.priceListId === list.id && item.productId === productId,
        ) as StoredFixed;
        return { status: 200, json: this.fixedView(row) };
      }
      if (method === 'DELETE') {
        const before = this.fixed.length;
        this.fixed = this.fixed.filter(
          (row) => !(row.priceListId === list.id && row.productId === productId),
        );
        return before === this.fixed.length ? error(404, 'NOT_FOUND') : { status: 204 };
      }
    }
    if (key === 'GET /api/admin/pricing/matrix') return { status: 200, json: this.matrix(url) };
    return null;
  }

  private chain(id: string): string[] {
    return listChain(this.lists, id);
  }

  private view(row: StoredList): PriceList {
    const productIds = this.catalog.products
      .filter((product) => !product.archivedAt)
      .map((p) => p.id);
    return {
      ...row,
      chain: this.chain(row.id),
      accounts: [...this.assigned.values()].filter((id) => id === row.id).length,
      rules: this.catalog.rules.filter((rule) => rule.priceListId === row.id).length,
      fixedPrices: this.fixed.filter((fixed) => fixed.priceListId === row.id).length,
      fallbackCells: productIds.filter((id) => this.cell(row.id, id).source === 'fixed_fallback')
        .length,
      ready: true,
    };
  }

  private fixedView(row: StoredFixed): FixedPrice {
    const product = this.catalog.productView(row.productId);
    const game = this.catalog.games.find((item) => item.id === product?.gameId);
    return {
      ...row,
      productNameAr: product?.nameAr ?? '',
      gameId: game?.id ?? '',
      gameNameAr: game?.nameAr ?? '',
      result: this.cell(row.priceListId, row.productId),
    };
  }

  /** LP1–LP4 now: the list's entry at the basis cost, capped at the retail price. */
  /** A product's price on a list now, as an order would be charged (null: none there). */
  priceOn(priceListId: string, productId: string): number | null {
    return this.cell(priceListId, productId).priceUsdUnits;
  }

  private cell(priceListId: string, productId: string): ListPriceCell {
    const pricing = this.catalog.pricing?.(productId);
    const cost = pricing?.basisCostUsdUnits ?? null;
    const retail = pricing?.price ?? null;
    const empty = { priceUsdUnits: null, source: null, marginUsdUnits: null, marginBp: null };
    if (cost === null || retail === null) return empty;
    const path = this.catalog.target('product', productId)?.path ?? {};
    const entry = resolveListEntry(
      this.chain(priceListId),
      { rules: this.catalog.rules, fixedPrices: this.fixed },
      { ...path, productId },
    );
    const price =
      priceListId === ROOT_PRICE_LIST_IDS.retail && !entry.fixed
        ? { priceUsdUnits: retail.priceUsdUnits, source: 'rule' as const }
        : listPrice(
            cost,
            { fixedPriceUsdUnits: entry.fixed?.priceUsdUnits ?? null, rule: entry.rule },
            priceListId === ROOT_PRICE_LIST_IDS.retail ? null : retail,
          );
    return {
      priceUsdUnits: price.priceUsdUnits,
      source: price.source,
      marginUsdUnits: price.priceUsdUnits - cost,
      marginBp: marginBasisPoints(price.priceUsdUnits, cost),
    };
  }

  /** The price a list would take at an estimate's cost, as the API's matrix does. */
  private estimated(priceListId: string, productId: string, cost: number): number {
    const path = { ...(this.catalog.target('product', productId)?.path ?? {}), productId };
    const facts = { rules: this.catalog.rules, fixedPrices: this.fixed };
    const at = (
      listId: string,
      retail: { priceUsdUnits: number; minMarginUsdUnits: number } | null,
    ) => {
      const entry = resolveListEntry(this.chain(listId), facts, path);
      return listPrice(
        cost,
        { fixedPriceUsdUnits: entry.fixed?.priceUsdUnits ?? null, rule: entry.rule },
        retail,
      );
    };
    const retail = at(ROOT_PRICE_LIST_IDS.retail, null);
    return priceListId === ROOT_PRICE_LIST_IDS.retail
      ? retail.priceUsdUnits
      : at(priceListId, retail).priceUsdUnits;
  }

  private matrix(url: URL): PriceMatrix {
    const gameId = url.searchParams.get('gameId');
    const q = url.searchParams.get('q');
    // Repeated (the panel's typed client) or comma-separated, retail always first, as the API.
    const asked = url.searchParams.getAll('listIds').flatMap((value) => value.split(','));
    const wanted = [
      ROOT_PRICE_LIST_IDS.retail,
      ...(asked.length > 0
        ? asked
        : [ROOT_PRICE_LIST_IDS.wholesale, ROOT_PRICE_LIST_IDS.cost]
      ).filter((id) => id !== ROOT_PRICE_LIST_IDS.retail),
    ];
    const lists = wanted.flatMap((id) =>
      this.lists.filter((row) => row.id === id && !row.archivedAt),
    );
    const categoryId = url.searchParams.get('categoryId');
    const games = (id: string) => this.catalog.games.find((item) => item.id === id);
    const products = this.catalog.products
      .filter(
        (product) =>
          !product.archivedAt &&
          (!gameId || product.gameId === gameId) &&
          (!q || product.nameAr.includes(q)) &&
          (!categoryId || games(product.gameId)?.categoryId === categoryId),
      )
      .sort((a, b) =>
        (games(a.gameId)?.nameAr ?? '').localeCompare(games(b.gameId)?.nameAr ?? '', 'ar'),
      );
    const rows = products.flatMap((product) => {
      const pricing = this.catalog.pricing?.(product.id);
      const held = pricing?.reviewOpen ?? false;
      const available = (pricing?.routed ?? false) && !held;
      const cost = pricing?.basisCostUsdUnits ?? null;
      const estimate = cost === null ? (this.estimates.get(product.id) ?? null) : null;
      const cells = lists.map((list): PriceMatrixCell => {
        const cell = this.cell(list.id, product.id);
        const parent = list.parentListId ? this.cell(list.parentListId, product.id) : null;
        return {
          priceListId: list.id,
          ...cell,
          availability: available && cell.priceUsdUnits !== null ? 'available' : 'out_of_stock',
          targetPriceUsdUnits: null,
          fixedPriceUsdUnits:
            this.fixed.find((row) => row.priceListId === list.id && row.productId === product.id)
              ?.priceUsdUnits ?? null,
          estimatedPriceUsdUnits:
            cell.priceUsdUnits === null && estimate
              ? this.estimated(list.id, product.id, estimate.costUsdUnits)
              : null,
          warnings: matrixCellWarnings({
            source: cell.source,
            priceUsdUnits: cell.priceUsdUnits,
            parentPriceUsdUnits: parent?.priceUsdUnits ?? null,
            held,
            available,
          }),
        };
      });
      const game = games(product.gameId);
      return [
        {
          productId: product.id,
          productNameAr: product.nameAr,
          gameId: product.gameId,
          gameNameAr: game?.nameAr ?? '',
          costUsdUnits: cost,
          supplierCode: pricing?.routed ? ('fake' as const) : null,
          estimate,
          held,
          cells,
        },
      ];
    });
    const query = priceMatrixQuerySchema.parse(Object.fromEntries(url.searchParams));
    return {
      lists: lists.map(({ id, kind, name }) => ({ id, kind, name })),
      ...selectMatrixRows(rows, query),
    };
  }
}
