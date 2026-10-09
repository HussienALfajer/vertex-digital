import {
  costChangeBasisPoints,
  isCostStale,
  MAX_IMPORT_ROWS,
  needsReview,
  orderRoutes,
  type PriceChangeCause,
  type PriceReview,
  type PriceReviewStatus,
  type ProductKind,
  type ProductPrice,
  priceFromCost,
  type Route,
  type RouteUnusableReason,
  routeTier,
  routeUnusableReason,
  SUPPLIER_CODES,
  SUPPLIER_CREDENTIAL_FIELDS,
  SUPPLIER_POLICY_DEFAULTS,
  type SupplierBalance,
  type SupplierCode,
  type SupplierDetail,
  type SupplierHealthChange,
  type SupplierHealthState,
  type SupplierOffer,
  type SupplierPolicy,
  type SupplierSummary,
  type SyncRun,
  supplierAvailable,
  supplierHasCatalog,
} from '@vertex-digital/contracts';
import { type Answer, type CatalogMock, nextId } from './catalog-mock';

/*
 * The suppliers and price reviews API of S07 as the panel sees it: suppliers with credentials,
 * syncs, offers, the import, routes with their usability (RT1–RT8), stored prices with the review
 * hold (P1–P6) and the policy, built on the contracts' pure rules so the flows meet the same
 * refusals and figures the API gives. A sync applies what the test scripted (`script`), as the
 * `supplier:fake` CLI does for the worker.
 */

type Body = Record<string, unknown> | null;

const NAMES: Record<SupplierCode, string> = {
  shop2topup: 'SHOP2TOPUP',
  wdgzone: 'WDGZone',
  manual: 'يدوي',
  fake: 'مورد تجريبي',
};

const USD = 1_000_000;

/** The fake supplier's catalog (`packages/suppliers/src/fake/adapter.ts`), costs in cents. */
const FAKE_CATALOG: [string, string, string, ProductKind, number][] = [
  ['fake-uc-60', 'Fake UC 60', 'PUBG Mobile', 'direct', 88],
  ['fake-uc-325', 'Fake UC 325', 'PUBG Mobile', 'direct', 440],
  ['fake-uc-660', 'Fake UC 660', 'PUBG Mobile', 'direct', 870],
  ['fake-uc-1800', 'Fake UC 1800', 'PUBG Mobile', 'direct', 2_190],
  ['fake-ff-100', 'Fake Free Fire 100', 'Free Fire', 'direct', 95],
  ['fake-ff-310', 'Fake Free Fire 310', 'Free Fire', 'direct', 290],
  ['fake-ff-520', 'Fake Free Fire 520', 'Free Fire', 'direct', 480],
  ['fake-ff-1060', 'Fake Free Fire 1060', 'Free Fire', 'direct', 950],
  ['fake-gift-10', 'Fake gift card 10', 'iTunes', 'code', 960],
  ['fake-itunes-25', 'Fake iTunes 25', 'iTunes', 'code', 2_400],
];

interface StoredSupplier {
  code: SupplierCode;
  credentials: { hints: Record<string, string>; setAt: string } | null;
  lowBalanceUsdUnits: number;
  healthHistory: SupplierHealthChange[];
  balanceHistory: SupplierBalance[];
  runs: SyncRun[];
}

type StoredOffer = Omit<SupplierOffer, 'costStale' | 'mapped'>;

interface StoredRoute {
  id: string;
  productId: string;
  supplierCode: SupplierCode;
  offerId: string;
  priority: number;
  enabled: boolean;
  fieldMap: Record<string, string>;
  archivedAt: string | null;
}

type StoredPrice = ProductPrice & { productId: string };

interface StoredReview {
  id: string;
  productId: string;
  routeId: string;
  costBeforeUsdUnits: number;
  costAfterUsdUnits: number;
  priceBeforeUsdUnits: number;
  proposedPriceUsdUnits: number;
  status: PriceReviewStatus;
  decidedAt: string | null;
  createdAt: string;
}

/** What a test scripts for the next sync of an offer, as the fake CLI does. */
interface Script {
  costUsdUnits?: number;
  inStock?: boolean;
  removed?: boolean;
}

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const notFound = () => error(404, 'NOT_FOUND');

const page = <T>(items: T[], url: URL) => {
  const number = Number(url.searchParams.get('page') ?? 1);
  const size = Number(url.searchParams.get('pageSize') ?? 50);
  return {
    items: items.slice((number - 1) * size, number * size),
    total: items.length,
    page: number,
    pageSize: size,
  };
};

export class SuppliersMock {
  readonly suppliers: StoredSupplier[] = SUPPLIER_CODES.map((code) => ({
    code,
    credentials: null,
    lowBalanceUsdUnits: 50 * USD,
    healthHistory: [],
    balanceHistory: [],
    runs: [],
  }));
  offers: StoredOffer[] = [];
  routes: StoredRoute[] = [];
  prices: StoredPrice[] = [];
  reviews: StoredReview[] = [];
  policy: SupplierPolicy = { ...SUPPLIER_POLICY_DEFAULTS };
  /** The next sync's changes per supplier offer id. */
  readonly scripts = new Map<string, Script>();
  /** The next sync of `fake` fails with this code (`--fail-sync on`). */
  failNextSync: string | null = null;

  constructor(
    private readonly catalog: CatalogMock,
    /** The `<code>_paused` switches (S05, rule SP3). */
    private readonly paused: (code: SupplierCode) => boolean,
    /** Sensitive routes answer `REAUTHENTICATION_REQUIRED` while this says so (rule D5). */
    private readonly reauthenticationRequired: () => boolean,
  ) {
    catalog.pricing = (productId) => this.pricing(productId);
    catalog.onRulesChanged = () => this.repriceAll('rule_change');
  }

  /** Sets the scene: the fake supplier with its keys and catalog, synced once. */
  connectFake(): void {
    const fake = this.supplier('fake');
    fake.credentials = { hints: { webhookSecret: 'c3d4' }, setAt: new Date().toISOString() };
    this.sync('fake', 'admin');
  }

  /** A scheduled sync (rule SY1), as the worker runs it every 15 minutes. */
  runSync(code: SupplierCode): SyncRun {
    return this.sync(code, 'schedule');
  }

  /** The changes the next sync applies to an offer, by the supplier's offer id. */
  script(offerId: string, change: Script): void {
    this.scripts.set(offerId, { ...this.scripts.get(offerId), ...change });
  }

  /** A balance read (rule H5), newest first. */
  readBalance(code: SupplierCode, amountUnits: number): void {
    this.supplier(code).balanceHistory.unshift({
      id: nextId(),
      currency: 'USD',
      amountUnits,
      createdAt: new Date().toISOString(),
    });
  }

  /** A health change (rules H1–H4), newest first, repricing the supplier's products. */
  setHealth(code: SupplierCode, state: SupplierHealthState, reason: string): void {
    this.supplier(code).healthHistory.unshift({
      id: nextId(),
      state,
      reason,
      calls: 12,
      successBp: state === 'healthy' ? 10_000 : state === 'degraded' ? 8_200 : 2_500,
      p90Ms: 900,
      createdAt: new Date().toISOString(),
    });
    this.reprice(this.productsOf(code), 'route_change');
  }

  /** A product's route to one of `code`'s offers, by the supplier's offer id, and its price. */
  map(productId: string, code: SupplierCode, offerId: string, fieldMap = {}): StoredRoute {
    const offer = this.offers.find(
      (item) => item.supplierCode === code && item.offerId === offerId,
    );
    if (!offer) throw new Error(`No offer ${offerId}`);
    const route = this.addRoute(productId, code, offer.id, fieldMap);
    this.reprice([productId], 'route_change');
    return route;
  }

  /** Rule SP3: a supplier's pause or resume reprices the products routed to it. */
  repriceSupplier(code: SupplierCode): void {
    this.reprice(this.productsOf(code), 'route_change');
  }

  private supplier(code: SupplierCode): StoredSupplier {
    return this.suppliers.find((item) => item.code === code) as StoredSupplier;
  }

  private available(code: SupplierCode) {
    return supplierAvailable(code, { fakeEnabled: true });
  }

  private configured(code: SupplierCode) {
    return SUPPLIER_CREDENTIAL_FIELDS[code].length === 0 || !!this.supplier(code).credentials;
  }

  private health(code: SupplierCode): SupplierHealthState {
    return code === 'manual'
      ? 'healthy'
      : (this.supplier(code).healthHistory[0]?.state ?? 'healthy');
  }

  private balanceUsd(code: SupplierCode): number | null {
    const balance = this.supplier(code).balanceHistory[0];
    return balance?.currency === 'USD' ? balance.amountUnits : null;
  }

  private productsOf(code: SupplierCode): string[] {
    return [
      ...new Set(
        this.routes.filter((route) => route.supplierCode === code).map((route) => route.productId),
      ),
    ];
  }

  // Routing (RT4–RT6, P1) ----------------------------------------------------------------------

  private unusable(route: StoredRoute): RouteUnusableReason | null {
    const offer = this.offers.find((item) => item.id === route.offerId) as StoredOffer;
    const product = this.catalog.products.find((item) => item.id === route.productId);
    const liveFieldKeys = this.catalog.fields
      .filter((field) => field.gameId === product?.gameId && !field.archivedAt)
      .map((field) => field.key);
    return routeUnusableReason(
      {
        archived: route.archivedAt !== null,
        enabled: route.enabled,
        supplierCode: route.supplierCode,
        supplierAvailable: this.available(route.supplierCode),
        supplierConfigured: this.configured(route.supplierCode),
        supplierPaused: this.paused(route.supplierCode),
        health: this.health(route.supplierCode),
        offerMissing: offer.missingSince !== null,
        inStock: offer.inStock,
        costUsdUnits: offer.costUsdUnits,
        costConfirmedAt: offer.costConfirmedAt ? new Date(offer.costConfirmedAt) : null,
        requiredFields: offer.requiredFields,
        fieldMap: route.fieldMap,
        liveFieldKeys,
        balanceUsdUnits: this.balanceUsd(route.supplierCode),
      },
      new Date(),
      this.policy,
    );
  }

  /** The product's usable routes in tier, cost, priority and supplier order (RT5, RT6). */
  private usable(productId: string) {
    return orderRoutes(
      this.routes
        .filter((route) => route.productId === productId && this.unusable(route) === null)
        .map((route) => ({
          route,
          supplierCode: route.supplierCode,
          health: this.health(route.supplierCode),
          costUsdUnits: this.offerOf(route).costUsdUnits as number,
          priority: route.priority,
        })),
    );
  }

  private offerOf(route: StoredRoute): StoredOffer {
    return this.offers.find((item) => item.id === route.offerId) as StoredOffer;
  }

  private currentPrice(productId: string): StoredPrice | null {
    return this.prices.find((price) => price.productId === productId) ?? null;
  }

  private openReview(productId: string): StoredReview | null {
    return (
      this.reviews.find((review) => review.productId === productId && review.status === 'open') ??
      null
    );
  }

  private pricing(productId: string) {
    const price = this.currentPrice(productId);
    const usable = this.usable(productId);
    const basis = usable[0]?.route;
    return {
      price: price
        ? {
            priceUsdUnits: price.priceUsdUnits,
            minMarginUsdUnits: this.catalog.ruleOf(productId).minMarginUsdUnits,
          }
        : null,
      usableRouteCostsUsdUnits: usable.map((item) => item.costUsdUnits),
      basisSupplierNameAr: basis ? NAMES[basis.supplierCode] : null,
      reviewOpen: this.openReview(productId) !== null,
    };
  }

  /** Rule P2 (with P3 and P5) for the given products. */
  private reprice(productIds: string[], cause: PriceChangeCause): number {
    let repriced = 0;
    for (const productId of productIds) {
      const basis = this.usable(productId)[0];
      if (!basis) continue;
      const rule = this.catalog.ruleOf(productId);
      const target = priceFromCost(basis.costUsdUnits, rule);
      const current = this.currentPrice(productId);
      if (current?.priceUsdUnits === target && current.routeId === basis.route.id) continue;
      const review = this.openReview(productId);
      if (review) {
        review.costAfterUsdUnits = basis.costUsdUnits;
        review.proposedPriceUsdUnits = target;
        continue;
      }
      if (
        cause === 'cost_sync' &&
        current &&
        current.routeId === basis.route.id &&
        needsReview(current.costUsdUnits, basis.costUsdUnits, this.policy.priceReviewThresholdBp)
      ) {
        this.reviews.unshift({
          id: nextId(),
          productId,
          routeId: basis.route.id,
          costBeforeUsdUnits: current.costUsdUnits,
          costAfterUsdUnits: basis.costUsdUnits,
          priceBeforeUsdUnits: current.priceUsdUnits,
          proposedPriceUsdUnits: target,
          status: 'open',
          decidedAt: null,
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      const sameRoute = current?.routeId === basis.route.id;
      this.appendPrice(
        productId,
        basis.route,
        basis.costUsdUnits,
        target,
        sameRoute ? cause : 'route_change',
        null,
      );
      repriced += 1;
    }
    return repriced;
  }

  private repriceAll(cause: PriceChangeCause) {
    this.reprice([...new Set(this.routes.map((route) => route.productId))], cause);
  }

  private appendPrice(
    productId: string,
    route: StoredRoute,
    costUsdUnits: number,
    priceUsdUnits: number,
    cause: PriceChangeCause,
    reviewId: string | null,
  ) {
    const rule = this.catalog.ruleOf(productId);
    this.prices.unshift({
      id: nextId(),
      productId,
      priceUsdUnits,
      costUsdUnits,
      routeId: route.id,
      supplierCode: route.supplierCode,
      ruleId: rule.id,
      percentBp: rule.percentBp,
      fixedUsdUnits: rule.fixedUsdUnits,
      minMarginUsdUnits: rule.minMarginUsdUnits,
      cause,
      reviewId,
      createdAt: new Date().toISOString(),
    });
  }

  private addRoute(
    productId: string,
    code: SupplierCode,
    offerId: string,
    fieldMap: Record<string, string>,
    priority = 1,
  ): StoredRoute {
    const route: StoredRoute = {
      id: nextId(),
      productId,
      supplierCode: code,
      offerId,
      priority,
      enabled: true,
      fieldMap,
      archivedAt: null,
    };
    this.routes.push(route);
    return route;
  }

  // Sync (SY1–SY4) -----------------------------------------------------------------------------

  /** One run: the fake catalog with the scripted changes, then the repricing of what changed. */
  private sync(code: SupplierCode, trigger: SyncRun['trigger']): SyncRun {
    const now = new Date().toISOString();
    const run: SyncRun = {
      id: nextId(),
      supplierCode: code,
      trigger,
      status: 'succeeded',
      startedAt: now,
      finishedAt: now,
      offersSeen: 0,
      offersNew: 0,
      costsChanged: 0,
      offersMissing: 0,
      reviewsOpened: 0,
      productsRepriced: 0,
      errorCode: null,
      errorMessage: null,
    };
    this.supplier(code).runs.unshift(run);
    if (code === 'fake' && this.failNextSync) {
      run.status = 'failed';
      run.errorCode = this.failNextSync;
      this.failNextSync = null;
      return run;
    }
    const changed = new Set<string>();
    for (const [offerId, name, group, kind, cents] of code === 'fake' ? FAKE_CATALOG : []) {
      const script = this.scripts.get(offerId) ?? {};
      let offer = this.offers.find(
        (item) => item.supplierCode === code && item.offerId === offerId,
      );
      if (script.removed) {
        if (offer && !offer.missingSince) {
          offer.missingSince = now;
          run.offersMissing += 1;
          changed.add(offer.id);
        }
        continue;
      }
      run.offersSeen += 1;
      const cost = script.costUsdUnits ?? offer?.costUsdUnits ?? cents * 10_000;
      if (!offer) {
        offer = {
          id: nextId(),
          supplierCode: code,
          offerId,
          name,
          groupName: group,
          kind,
          requiredFields: kind === 'direct' ? ['playerId'] : [],
          costUsdUnits: cost,
          costRaw: null,
          inStock: true,
          costConfirmedAt: now,
          lastSeenAt: now,
          missingSince: null,
        };
        this.offers.push(offer);
        run.offersNew += 1;
      }
      if (offer.costUsdUnits !== cost) {
        offer.costUsdUnits = cost;
        run.costsChanged += 1;
        changed.add(offer.id);
      }
      if (script.inStock !== undefined && offer.inStock !== script.inStock) {
        offer.inStock = script.inStock;
        changed.add(offer.id);
      }
      if (offer.missingSince) changed.add(offer.id);
      offer.missingSince = null;
      offer.costConfirmedAt = now;
      offer.lastSeenAt = now;
    }
    this.scripts.clear();
    const products = [
      ...new Set(
        this.routes.filter((route) => changed.has(route.offerId)).map((route) => route.productId),
      ),
    ];
    const reviewsBefore = this.reviews.length;
    run.productsRepriced = this.reprice(products, 'cost_sync');
    run.reviewsOpened = this.reviews.length - reviewsBefore;
    return run;
  }

  // Views ----------------------------------------------------------------------------------------

  private summary(row: StoredSupplier): SupplierSummary {
    const balance = row.balanceHistory[0] ?? null;
    return {
      code: row.code,
      nameAr: NAMES[row.code],
      available: this.available(row.code),
      configured: this.configured(row.code),
      paused: this.paused(row.code),
      health: this.health(row.code),
      healthSince: row.healthHistory[0]?.createdAt ?? null,
      balance,
      balanceLow:
        row.code !== 'manual' &&
        balance?.currency === 'USD' &&
        balance.amountUnits < row.lowBalanceUsdUnits,
      lowBalanceUsdUnits: row.lowBalanceUsdUnits,
      lastRun: row.runs[0] ?? null,
      offerCount: this.offers.filter((offer) => offer.supplierCode === row.code).length,
      mappedCount: this.offers.filter(
        (offer) =>
          offer.supplierCode === row.code &&
          this.routes.some((route) => route.offerId === offer.id && !route.archivedAt),
      ).length,
      // S09 rule AD2 (its panel arrives with S09's screens).
      canValidatePlayer: row.code === 'fake',
      validationQuota: 1_000,
      validationsToday: 0,
    };
  }

  private detail(row: StoredSupplier): SupplierDetail {
    return {
      ...this.summary(row),
      credentialFields: [...SUPPLIER_CREDENTIAL_FIELDS[row.code]],
      credentials: row.credentials,
      healthHistory: row.healthHistory.slice(0, 20),
      balanceHistory: row.balanceHistory.slice(0, 20),
    };
  }

  private offer(row: StoredOffer): SupplierOffer {
    const route = this.routes.find((item) => item.offerId === row.id && !item.archivedAt);
    const product = route && this.catalog.products.find((item) => item.id === route.productId);
    const game = product && this.catalog.games.find((item) => item.id === product.gameId);
    return {
      ...row,
      costStale: isCostStale(
        row.supplierCode,
        row.costConfirmedAt ? new Date(row.costConfirmedAt) : null,
        new Date(),
        this.policy,
      ),
      mapped:
        route && product && game
          ? {
              routeId: route.id,
              productId: product.id,
              productNameAr: product.nameAr,
              gameId: game.id,
              gameNameAr: game.nameAr,
            }
          : null,
    };
  }

  private route(row: StoredRoute, basisId: string | null): Route {
    const offer = this.offerOf(row);
    const reason = this.unusable(row);
    return {
      id: row.id,
      supplierCode: row.supplierCode,
      supplierNameAr: NAMES[row.supplierCode],
      offer: {
        id: offer.id,
        offerId: offer.offerId,
        name: offer.name,
        kind: offer.kind,
        requiredFields: offer.requiredFields,
        costUsdUnits: offer.costUsdUnits,
        costConfirmedAt: offer.costConfirmedAt,
        inStock: offer.inStock,
        missingSince: offer.missingSince,
      },
      priority: row.priority,
      enabled: row.enabled,
      fieldMap: row.fieldMap,
      archivedAt: row.archivedAt,
      tier: reason === null ? routeTier(row.supplierCode, this.health(row.supplierCode)) : null,
      unusableReason: reason,
      basis: row.id === basisId,
      requirementsUnknown: offer.requiredFields === null,
    };
  }

  /** `productRoutingSchema`: usable routes in order, then unusable, then archived. */
  routing(productId: string) {
    const usable = this.usable(productId).map((item) => item.route);
    const basisId = usable[0]?.id ?? null;
    const others = this.routes.filter(
      (route) => route.productId === productId && !usable.includes(route),
    );
    const ordered = [
      ...usable,
      ...others.filter((route) => !route.archivedAt),
      ...others.filter((route) => route.archivedAt),
    ];
    const current = this.currentPrice(productId);
    const basis = this.usable(productId)[0];
    const review = this.openReview(productId);
    return {
      productId,
      routes: ordered.map((route) => this.route(route, basisId)),
      basisRouteId: basisId,
      currentPrice: current
        ? {
            priceUsdUnits: current.priceUsdUnits,
            costUsdUnits: current.costUsdUnits,
            routeId: current.routeId,
            createdAt: current.createdAt,
          }
        : null,
      targetPriceUsdUnits: basis
        ? priceFromCost(basis.costUsdUnits, this.catalog.ruleOf(productId))
        : null,
      openReview: review
        ? {
            id: review.id,
            costBeforeUsdUnits: review.costBeforeUsdUnits,
            costAfterUsdUnits: review.costAfterUsdUnits,
            changeBp: costChangeBasisPoints(review.costBeforeUsdUnits, review.costAfterUsdUnits),
            proposedPriceUsdUnits: review.proposedPriceUsdUnits,
          }
        : null,
      availability: this.catalog.availabilityOf(productId),
    };
  }

  private review(row: StoredReview): PriceReview {
    const product = this.catalog.products.find((item) => item.id === row.productId);
    const game = this.catalog.games.find((item) => item.id === product?.gameId);
    const route = this.routes.find((item) => item.id === row.routeId) as StoredRoute;
    const current = this.currentPrice(row.productId);
    const held = current?.priceUsdUnits ?? row.priceBeforeUsdUnits;
    return {
      id: row.id,
      productId: row.productId,
      productNameAr: product?.nameAr ?? '',
      gameId: game?.id ?? '',
      gameNameAr: game?.nameAr ?? '',
      supplierCode: route.supplierCode,
      supplierNameAr: NAMES[route.supplierCode],
      routeId: row.routeId,
      costBeforeUsdUnits: row.costBeforeUsdUnits,
      costAfterUsdUnits: row.costAfterUsdUnits,
      changeBp: costChangeBasisPoints(row.costBeforeUsdUnits, row.costAfterUsdUnits),
      priceBeforeUsdUnits: row.priceBeforeUsdUnits,
      proposedPriceUsdUnits: row.proposedPriceUsdUnits,
      heldMarginUsdUnits: held - row.costAfterUsdUnits,
      proposedMarginUsdUnits: row.proposedPriceUsdUnits - row.costAfterUsdUnits,
      status: row.status,
      availability: this.catalog.availabilityOf(row.productId),
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    };
  }

  /** Rule P4's accept: refused when the price the admin saw is no longer the proposal. */
  private accept(review: StoredReview, expected: number | undefined, cause: PriceChangeCause) {
    const basis = this.usable(review.productId)[0];
    const target = basis
      ? priceFromCost(basis.costUsdUnits, this.catalog.ruleOf(review.productId))
      : null;
    if (target === null || (expected !== undefined && target !== expected)) {
      return {
        result: 'refused' as const,
        errorCode: 'REVIEW_STALE' as const,
        proposedPriceUsdUnits: target,
      };
    }
    review.status = cause === 'margin_adjusted' ? 'margin_adjusted' : 'accepted';
    review.decidedAt = new Date().toISOString();
    const current = this.currentPrice(review.productId);
    if (basis && (current?.priceUsdUnits !== target || current.routeId !== basis.route.id)) {
      this.appendPrice(review.productId, basis.route, basis.costUsdUnits, target, cause, review.id);
    }
    return { result: 'accepted' as const };
  }

  // Routes ---------------------------------------------------------------------------------------

  /** Answers a suppliers, routes, prices or reviews route, or null when `path` is not one. */
  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const match = (pattern: RegExp) => path.match(pattern);
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    if (key === 'GET /api/admin/suppliers') {
      return { status: 200, json: this.suppliers.map((row) => this.summary(row)) };
    }
    if (key === 'GET /api/admin/suppliers/policy') return { status: 200, json: this.policy };
    if (key === 'PUT /api/admin/suppliers/policy') {
      const refusal = sensitive();
      if (refusal) return refusal;
      this.policy = body as unknown as SupplierPolicy;
      this.repriceAll('route_change');
      return { status: 200, json: this.policy };
    }
    const costs = match(/^\/api\/admin\/suppliers\/offers\/([^/]+)\/costs$/);
    if (costs && method === 'GET') {
      if (!this.offers.some((offer) => offer.id === costs[1])) return notFound();
      return { status: 200, json: page([], url) };
    }
    const supplierPath = match(/^\/api\/admin\/suppliers\/([^/]+)(?:\/([a-z]+))?$/);
    if (supplierPath) {
      const code = supplierPath[1] as SupplierCode;
      const row = this.suppliers.find((item) => item.code === code);
      if (!row) return notFound();
      const action = supplierPath[2];
      if (!action && method === 'GET') {
        // The connection test ends on the panel's next read (rule SP2).
        const run = row.runs[0];
        if (run?.status === 'running') {
          row.runs.shift();
          this.sync(code, run.trigger);
        }
        return { status: 200, json: this.detail(row) };
      }
      if (!action && method === 'PATCH') {
        const refusal = sensitive();
        if (refusal) return refusal;
        row.lowBalanceUsdUnits = Number(body?.lowBalanceUsdUnits);
        return { status: 200, json: this.detail(row) };
      }
      if (action === 'credentials' && method === 'PUT') {
        const refusal = sensitive();
        if (refusal) return refusal;
        const values = (body?.values ?? {}) as Record<string, string>;
        row.credentials = {
          hints: Object.fromEntries(
            Object.entries(values)
              .filter(([, value]) => value.length > 12)
              .map(([field, value]) => [field, value.slice(-4)]),
          ),
          setAt: new Date().toISOString(),
        };
        if (supplierHasCatalog(code) && this.available(code)) {
          const now = new Date().toISOString();
          row.runs.unshift({
            id: nextId(),
            supplierCode: code,
            trigger: 'admin',
            status: 'running',
            startedAt: now,
            finishedAt: null,
            offersSeen: 0,
            offersNew: 0,
            costsChanged: 0,
            offersMissing: 0,
            reviewsOpened: 0,
            productsRepriced: 0,
            errorCode: null,
            errorMessage: null,
          });
        }
        return { status: 200, json: this.detail(row) };
      }
      if (action === 'sync' && method === 'POST') {
        if (!this.configured(code)) return error(409, 'SUPPLIER_NOT_CONFIGURED');
        if (!this.available(code)) return error(409, 'SUPPLIER_UNAVAILABLE');
        return { status: 202, json: this.sync(code, 'admin') };
      }
      if (action === 'runs' && method === 'GET') return { status: 200, json: page(row.runs, url) };
      if (action === 'offers' && method === 'GET') {
        const q = url.searchParams.get('q')?.toLowerCase();
        const group = url.searchParams.get('group');
        const flag = (name: string) => url.searchParams.get(name);
        const items = this.offers
          .filter((offer) => offer.supplierCode === code)
          .map((offer) => this.offer(offer))
          .filter(
            (offer) =>
              !q || offer.name.toLowerCase().includes(q) || offer.offerId.toLowerCase().includes(q),
          )
          .filter((offer) => !group || offer.groupName === group)
          .filter((offer) => !flag('mapped') || String(offer.mapped !== null) === flag('mapped'))
          .filter(
            (offer) => !flag('missing') || String(offer.missingSince !== null) === flag('missing'),
          )
          .filter((offer) => !flag('inStock') || String(offer.inStock) === flag('inStock'))
          .sort(
            (a, b) =>
              (a.groupName ?? '').localeCompare(b.groupName ?? '') || a.name.localeCompare(b.name),
          );
        return { status: 200, json: page(items, url) };
      }
      if (action === 'import' && method === 'POST') return this.import(code, body);
    }

    // Routes -------------------------------------------------------------------------------------
    const productRoutes = match(
      /^\/api\/admin\/catalog\/products\/([^/]+)\/(routes|routes\/manual|prices)$/,
    );
    if (productRoutes) {
      const productId = productRoutes[1] as string;
      const product = this.catalog.products.find((item) => item.id === productId);
      if (!product) return notFound();
      if (productRoutes[2] === 'prices' && method === 'GET') {
        return {
          status: 200,
          json: page(
            this.prices.filter((price) => price.productId === productId),
            url,
          ),
        };
      }
      if (productRoutes[2] === 'routes' && method === 'GET') {
        return { status: 200, json: this.routing(productId) };
      }
      if (productRoutes[2] === 'routes' && method === 'POST') {
        const offer = this.offers.find((item) => item.id === body?.offerId);
        if (!offer) return notFound();
        const refusal = this.routeRefusal(
          product,
          offer,
          (body?.fieldMap ?? {}) as Record<string, string>,
        );
        if (refusal) return refusal;
        this.addRoute(
          productId,
          offer.supplierCode,
          offer.id,
          (body?.fieldMap ?? {}) as Record<string, string>,
          Number(body?.priority ?? 1),
        );
        this.reprice([productId], 'route_change');
        return { status: 201, json: this.routing(productId) };
      }
      if (productRoutes[2] === 'routes/manual' && method === 'POST') {
        const refusal = sensitive();
        if (refusal) return refusal;
        if (
          this.routes.some(
            (route) =>
              route.productId === productId && route.supplierCode === 'manual' && !route.archivedAt,
          )
        ) {
          return error(409, 'ROUTE_EXISTS');
        }
        const now = new Date().toISOString();
        const offer: StoredOffer = {
          id: nextId(),
          supplierCode: 'manual',
          offerId: nextId(),
          name: product.nameAr,
          groupName: null,
          kind: product.kind,
          requiredFields: [],
          costUsdUnits: Number(body?.costUsdUnits),
          costRaw: null,
          inStock: true,
          costConfirmedAt: now,
          lastSeenAt: now,
          missingSince: null,
        };
        this.offers.push(offer);
        this.addRoute(productId, 'manual', offer.id, {});
        this.reprice([productId], 'route_change');
        return { status: 201, json: this.routing(productId) };
      }
    }
    const routePath = match(/^\/api\/admin\/routes\/([^/]+)(?:\/(archive|restore|manual-cost))?$/);
    if (routePath) {
      const route = this.routes.find((item) => item.id === routePath[1]);
      if (!route) return notFound();
      const action = routePath[2];
      if (action === 'manual-cost') {
        const refusal = sensitive();
        if (refusal) return refusal;
        this.offerOf(route).costUsdUnits = Number(body?.costUsdUnits);
      } else if (action === 'archive') {
        route.archivedAt = new Date().toISOString();
      } else if (action === 'restore') {
        if (
          this.routes.some(
            (item) =>
              item !== route &&
              !item.archivedAt &&
              item.productId === route.productId &&
              item.supplierCode === route.supplierCode,
          )
        ) {
          return error(409, 'ROUTE_EXISTS');
        }
        route.archivedAt = null;
      } else {
        const next = { ...route, ...(body as Partial<StoredRoute>) };
        const missing = (this.offerOf(route).requiredFields ?? []).filter(
          (field) => !next.fieldMap[field],
        );
        if (next.enabled && missing.length > 0) {
          return error(409, 'ROUTE_FIELDS_UNMAPPED', { fields: missing });
        }
        Object.assign(route, body);
      }
      this.reprice([route.productId], 'route_change');
      return { status: 200, json: this.routing(route.productId) };
    }

    // Reviews ------------------------------------------------------------------------------------
    if (key === 'GET /api/admin/pricing/reviews') {
      const status = url.searchParams.get('status') ?? 'open';
      const supplier = url.searchParams.get('supplier');
      const items = this.reviews
        .filter((review) => review.status === status)
        .map((review) => this.review(review))
        .filter((review) => !supplier || review.supplierCode === supplier);
      return { status: 200, json: page(items, url) };
    }
    if (key === 'POST /api/admin/pricing/reviews/decide') {
      const decisions = (body?.decisions ?? []) as {
        reviewId: string;
        action: 'accept' | 'pause';
        expectedPriceUsdUnits?: number;
      }[];
      const results = decisions.map((decision) => {
        const review = this.reviews.find((item) => item.id === decision.reviewId);
        if (!review)
          return { reviewId: decision.reviewId, result: 'refused', errorCode: 'NOT_FOUND' };
        if (review.status !== 'open') {
          return { reviewId: review.id, result: 'refused', errorCode: 'REVIEW_CLOSED' };
        }
        if (decision.action === 'pause') {
          review.status = 'paused';
          review.decidedAt = new Date().toISOString();
          const product = this.catalog.products.find((item) => item.id === review.productId);
          if (product) product.status = 'paused';
          return { reviewId: review.id, result: 'paused' };
        }
        return {
          reviewId: review.id,
          ...this.accept(review, decision.expectedPriceUsdUnits, 'review_accepted'),
        };
      });
      return { status: 200, json: { results } };
    }
    const adjust = match(/^\/api\/admin\/pricing\/reviews\/([^/]+)\/adjust-margin$/);
    if (adjust && method === 'POST') {
      const refusal = sensitive();
      if (refusal) return refusal;
      const review = this.reviews.find((item) => item.id === adjust[1]);
      if (!review) return notFound();
      if (review.status !== 'open') return error(409, 'REVIEW_CLOSED');
      this.catalog.setProductRule(review.productId, body as never);
      this.accept(review, undefined, 'margin_adjusted');
      return { status: 200, json: this.review(review) };
    }
    return null;
  }

  /** Rules RT1–RT3: why an offer cannot be routed to this product, or null. */
  private routeRefusal(
    product: { id: string; kind: ProductKind },
    offer: StoredOffer,
    fieldMap: Record<string, string>,
  ): Answer | null {
    if (offer.supplierCode === 'manual') return error(400, 'VALIDATION_FAILED');
    if (offer.missingSince) return error(409, 'OFFER_MISSING');
    if (this.routes.some((route) => route.offerId === offer.id && !route.archivedAt)) {
      return error(409, 'OFFER_ALREADY_MAPPED');
    }
    if (
      this.routes.some(
        (route) =>
          route.productId === product.id &&
          route.supplierCode === offer.supplierCode &&
          !route.archivedAt,
      )
    ) {
      return error(409, 'ROUTE_EXISTS');
    }
    if (offer.kind && offer.kind !== product.kind) return error(409, 'ROUTE_KIND_MISMATCH');
    const missing = (offer.requiredFields ?? []).filter((field) => !fieldMap[field]);
    if (missing.length > 0) return error(409, 'ROUTE_FIELDS_UNMAPPED', { fields: missing });
    return null;
  }

  /** Rule RT8: all or nothing, every refused row in `details.rows`. */
  private import(code: SupplierCode, body: Body): Answer {
    const gameId = String(body?.gameId);
    const game = this.catalog.games.find((item) => item.id === gameId);
    if (!game) return notFound();
    const fieldMap = (body?.fieldMap ?? {}) as Record<string, string>;
    const rows = (body?.rows ?? []) as { offerId: string; nameAr: string }[];
    const live = this.catalog.products.filter((item) => item.gameId === gameId && !item.archivedAt);
    const errors = rows.flatMap((row, index) => {
      const offer = this.offers.find(
        (item) => item.id === row.offerId && item.supplierCode === code,
      );
      if (!offer) return [{ index, code: 'NOT_FOUND' }];
      const kind = offer.kind ?? (body?.kind as ProductKind);
      if (live.some((item) => item.nameAr === row.nameAr)) return [{ index, code: 'NAME_TAKEN' }];
      if (live.length + rows.length > MAX_IMPORT_ROWS) {
        return [{ index, code: 'CATALOG_LIMIT_REACHED' }];
      }
      const missing = (offer.requiredFields ?? []).filter((field) => !fieldMap[field]);
      if (kind === 'direct' && missing.length > 0) {
        return [{ index, code: 'ROUTE_FIELDS_UNMAPPED', fields: missing }];
      }
      if (this.routes.some((route) => route.offerId === offer.id && !route.archivedAt)) {
        return [{ index, code: 'OFFER_ALREADY_MAPPED' }];
      }
      return [];
    });
    const [first] = errors;
    if (first) return error(first.code === 'NOT_FOUND' ? 404 : 409, first.code, { rows: errors });
    const products = rows.map((row) => {
      const offer = this.offers.find((item) => item.id === row.offerId) as StoredOffer;
      const product = this.catalog.addProduct(gameId, {
        nameAr: row.nameAr,
        kind: offer.kind ?? (body?.kind as ProductKind),
        status: 'paused',
      });
      const route = this.addRoute(product.id, code, offer.id, fieldMap);
      this.reprice([product.id], 'route_change');
      return {
        id: product.id,
        nameAr: product.nameAr,
        routeId: route.id,
        priceUsdUnits: this.currentPrice(product.id)?.priceUsdUnits ?? null,
      };
    });
    return { status: 201, json: { products } };
  }
}
