import {
  DELIVERY_MEASURE_DAYS,
  DELIVERY_MEASURE_MIN_DELIVERIES,
  type MarginRuleValues,
  orderRoutes,
  type ProductAvailability,
  type ProductKind,
  priceBasis,
  priceFromCost,
  productAvailability,
  type RouteTier,
  type RouteUnusableReason,
  resolveMarginRule,
  routeTier,
  routeUnusableReason,
  STORE_SWITCH_DEFAULTS,
  SUPPLIER_PAUSE_SWITCHES,
  SUPPLIER_POLICY_DEFAULTS,
  type SupplierCode,
  type SupplierHealthState,
  type SupplierPolicy,
  supplierAvailable,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { type Database, readAll, type Transaction } from '../client.js';
import {
  catalogCategories,
  catalogGames,
  catalogInputFields,
  catalogProducts,
  fulfilmentAttempts,
  marginRules,
  priceReviews,
  productPrices,
  productRoutes,
  storeSwitchChanges,
  supplierBalanceReads,
  supplierCredentials,
  supplierHealthChanges,
  supplierOffers,
  supplierPolicy,
  suppliers,
} from '../schema/index.js';

/*
 * What a product's price and availability follow (S07 rules RT4–RT6, P1, P6), read in bulk for
 * the repricing write path, the panel and (S09) the store. Pure decisions are the contracts';
 * this file only gathers their facts.
 */

type Executor = Database | Transaction;

/** What the caller knows that the database does not: the time and which adapters it has. */
export interface RoutingContext {
  now: Date;
  /** `SUPPLIER_FAKE_ENABLED` (rule SP1). */
  fakeEnabled: boolean;
}

export interface SupplierState {
  id: string;
  code: SupplierCode;
  nameAr: string;
  lowBalanceUsdUnits: number;
  /** S09 rule PV5: player checks a Damascus day. */
  validationDailyQuota: number;
  available: boolean;
  configured: boolean;
  paused: boolean;
  /** S19 FC9: the last account read found the plan inactive: no routing or checks. */
  subscriptionInactive: boolean;
  /** S19 FC9: the plan as the last account read said, or null before any. */
  account: {
    plan: string;
    expiresAt: Date | null;
    active: boolean;
    autoRenew: boolean | null;
    checkedAt: Date;
  } | null;
  health: SupplierHealthState;
  healthSince: Date | null;
  balance: { id: string; currency: 'USD' | 'SYP'; amountUnits: number; createdAt: Date } | null;
}

export interface RouteState {
  id: string;
  productId: string;
  supplier: SupplierState;
  supplierCode: SupplierCode;
  health: SupplierHealthState;
  offer: typeof supplierOffers.$inferSelect;
  costUsdUnits: number | null;
  priority: number;
  enabled: boolean;
  fieldMap: Record<string, string>;
  /** S16 MF2. */
  optionMap: Record<string, Record<string, string>>;
  /** S17 WR3. */
  priceBasis: boolean;
  /** S17 WR9, WR10: copied onto the attempts it gets. */
  expectedDeliveryMinutes: number | null;
  hardLimitMinutes: number | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  unusableReason: RouteUnusableReason | null;
  /** Null for an unusable route. */
  tier: RouteTier | null;
  /** S19 RT12: its supplier's measured delivery time, or null without a measure. */
  deliveryMedianMs: number | null;
}

export type PriceRow = typeof productPrices.$inferSelect;
export type ReviewRow = typeof priceReviews.$inferSelect;

export interface ProductRoutingState {
  productId: string;
  nameAr: string;
  kind: ProductKind;
  gameId: string;
  categoryId: string;
  /** Usable routes in order (RT5, RT6), then the others: unusable, then archived. */
  routes: RouteState[];
  /** Rules P1, S17 WR3, WR4: null with no usable route, or while the price is held. */
  basis: RouteState | null;
  /** S17 WR4: a priced product with usable routes but none that counts: the price stays. */
  priceHeld: boolean;
  rule: { id: string; values: MarginRuleValues };
  /** The price the basis gives now (rule P1); null with no usable route. */
  targetPriceUsdUnits: number | null;
  current: PriceRow | null;
  openReview: ReviewRow | null;
  availability: ProductAvailability;
}

/** The policy in force: the newest `supplier_policy` row (the seed at least). */
export async function currentSupplierPolicy(db: Executor): Promise<SupplierPolicy> {
  const [row] = await db
    .select()
    .from(supplierPolicy)
    .orderBy(desc(supplierPolicy.createdAt), desc(supplierPolicy.id))
    .limit(1);
  if (!row) return SUPPLIER_POLICY_DEFAULTS;
  return {
    priceReviewThresholdBp: row.priceReviewThresholdBp,
    costStaleMinutes: row.costStaleMinutes,
    healthWindowMinutes: row.healthWindowMinutes,
    healthMinCalls: row.healthMinCalls,
    degradedSuccessBp: row.degradedSuccessBp,
    degradedP90Ms: row.degradedP90Ms,
    downSuccessBp: row.downSuccessBp,
    downConsecutiveErrors: row.downConsecutiveErrors,
    probeAfterMinutes: row.probeAfterMinutes,
    lowStockUnits: row.lowStockUnits,
    recoverSuccessBp: row.recoverSuccessBp,
    recoverMinutes: row.recoverMinutes,
  };
}

/**
 * Every supplier with what rule RT4 reads about it: available (SP1), configured (a credentials
 * row, or none needed), paused (SP3), its newest health and balance.
 */
export async function supplierStates(
  db: Executor,
  context: Pick<RoutingContext, 'fakeEnabled'>,
): Promise<SupplierState[]> {
  const [rows, credentials, health, balances, switches] = await readAll(db, [
    () => db.select().from(suppliers).orderBy(asc(suppliers.code)),
    () =>
      db.selectDistinct({ supplierId: supplierCredentials.supplierId }).from(supplierCredentials),
    () =>
      db
        .selectDistinctOn([supplierHealthChanges.supplierId])
        .from(supplierHealthChanges)
        .orderBy(
          supplierHealthChanges.supplierId,
          desc(supplierHealthChanges.createdAt),
          desc(supplierHealthChanges.id),
        ),
    () =>
      db
        .selectDistinctOn([supplierBalanceReads.supplierId])
        .from(supplierBalanceReads)
        .orderBy(
          supplierBalanceReads.supplierId,
          desc(supplierBalanceReads.createdAt),
          desc(supplierBalanceReads.id),
        ),
    () =>
      db
        .selectDistinctOn([storeSwitchChanges.switch], {
          switch: storeSwitchChanges.switch,
          value: storeSwitchChanges.value,
        })
        .from(storeSwitchChanges)
        .where(inArray(storeSwitchChanges.switch, Object.values(SUPPLIER_PAUSE_SWITCHES)))
        .orderBy(storeSwitchChanges.switch, desc(storeSwitchChanges.createdAt)),
  ]);
  const configured = new Set(credentials.map((row) => row.supplierId));
  const healthOf = new Map(health.map((row) => [row.supplierId, row]));
  const balanceOf = new Map(balances.map((row) => [row.supplierId, row]));
  const switchValue = new Map(switches.map((row) => [row.switch, row.value]));
  return rows.map((row) => {
    const pause = SUPPLIER_PAUSE_SWITCHES[row.code];
    const state = healthOf.get(row.id);
    const balance = balanceOf.get(row.id);
    return {
      id: row.id,
      code: row.code,
      nameAr: row.nameAr,
      lowBalanceUsdUnits: row.lowBalanceUsdUnits,
      validationDailyQuota: row.validationDailyQuota,
      available: supplierAvailable(row.code, context),
      configured: row.code === 'manual' || configured.has(row.id),
      paused: switchValue.get(pause) ?? STORE_SWITCH_DEFAULTS[pause],
      subscriptionInactive: row.accountActive === false,
      account:
        row.accountPlan !== null && row.accountActive !== null && row.accountCheckedAt !== null
          ? {
              plan: row.accountPlan,
              expiresAt: row.accountPlanExpiresAt,
              active: row.accountActive,
              autoRenew: row.accountAutoRenew,
              checkedAt: row.accountCheckedAt,
            }
          : null,
      // The manual supplier is always healthy (rule H1).
      health: row.code === 'manual' ? 'healthy' : (state?.state ?? 'healthy'),
      healthSince: state?.createdAt ?? null,
      balance: balance
        ? {
            id: balance.id,
            currency: balance.currency,
            amountUnits: balance.amountUnits,
            createdAt: balance.createdAt,
          }
        : null,
    };
  });
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * S19 RT12: per supplier, the median time from the first send to the delivery of its routed
 * attempts delivered in the last 7 days by the supplier's own answer (an admin's resolution says
 * nothing of its speed), for suppliers with at least 10 of them; in milliseconds.
 */
export async function supplierDeliveryMedians(
  db: Executor,
  now: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      supplierId: fulfilmentAttempts.supplierId,
      medianMs:
        sql<number>`percentile_cont(0.5) within group (order by extract(epoch from ${fulfilmentAttempts.resolvedAt} - ${fulfilmentAttempts.sendStartedAt}) * 1000)`.mapWith(
          Number,
        ),
    })
    .from(fulfilmentAttempts)
    .where(
      and(
        eq(fulfilmentAttempts.status, 'delivered'),
        eq(fulfilmentAttempts.kind, 'routed'),
        ne(fulfilmentAttempts.resolvedBy, 'admin'),
        isNotNull(fulfilmentAttempts.sendStartedAt),
        gte(
          fulfilmentAttempts.resolvedAt,
          new Date(now.getTime() - DELIVERY_MEASURE_DAYS * DAY_MS),
        ),
      ),
    )
    .groupBy(fulfilmentAttempts.supplierId)
    .having(sql`count(*) >= ${DELIVERY_MEASURE_MIN_DELIVERIES}`);
  return new Map(
    rows.flatMap((row) =>
      row.supplierId === null ? [] : [[row.supplierId, Math.max(0, Math.round(row.medianMs))]],
    ),
  );
}

/** S19 RT12: the measure is read again at most once a minute per process (no table). */
const DELIVERY_MEASURE_TTL_MS = 60_000;

let deliveryMeasure: { at: number; medians: ReadonlyMap<string, number> } | null = null;

async function measuredDelivery(db: Executor, now: Date): Promise<ReadonlyMap<string, number>> {
  if (deliveryMeasure && Math.abs(now.getTime() - deliveryMeasure.at) < DELIVERY_MEASURE_TTL_MS) {
    return deliveryMeasure.medians;
  }
  const medians = await supplierDeliveryMedians(db, now);
  deliveryMeasure = { at: now.getTime(), medians };
  return medians;
}

/** Drops the kept measure, so the next routing read measures again (tests). */
export function forgetDeliveryMeasure(): void {
  deliveryMeasure = null;
}

/**
 * The routing state of each product (rules RT4–RT6, P1, P6), keyed by product id. Unknown ids are
 * left out. Reads only: the repricing write path locks the products first. S19 RT11: routes of one
 * tier and cost are ordered by their suppliers' measured delivery time (RT12).
 */
export async function productRoutingStates(
  db: Executor,
  productIds: readonly string[],
  context: RoutingContext,
): Promise<Map<string, ProductRoutingState>> {
  const states = new Map<string, ProductRoutingState>();
  if (productIds.length === 0) return states;
  const ids = [...new Set(productIds)];
  const [products, routeRows, supplierList, rules, prices, reviews, policy, medians] =
    await readAll(db, [
      () =>
        db
          .select({
            product: catalogProducts,
            gameStatus: catalogGames.status,
            gameArchivedAt: catalogGames.archivedAt,
            categoryId: catalogGames.categoryId,
            categoryArchivedAt: catalogCategories.archivedAt,
          })
          .from(catalogProducts)
          .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
          .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
          .where(inArray(catalogProducts.id, ids)),
      () =>
        db
          .select({ route: productRoutes, offer: supplierOffers })
          .from(productRoutes)
          .innerJoin(supplierOffers, eq(supplierOffers.id, productRoutes.offerId))
          .where(inArray(productRoutes.productId, ids))
          .orderBy(asc(productRoutes.createdAt)),
      () => supplierStates(db, context),
      () => db.select().from(marginRules).where(isNull(marginRules.archivedAt)),
      () =>
        db
          .selectDistinctOn([productPrices.productId])
          .from(productPrices)
          .where(inArray(productPrices.productId, ids))
          .orderBy(productPrices.productId, desc(productPrices.createdAt), desc(productPrices.id)),
      () =>
        db
          .select()
          .from(priceReviews)
          .where(and(inArray(priceReviews.productId, ids), eq(priceReviews.status, 'open'))),
      () => currentSupplierPolicy(db),
      () => measuredDelivery(db, context.now),
    ]);
  const gameIds = [...new Set(products.map((row) => row.product.gameId))];
  const fields =
    gameIds.length === 0
      ? []
      : await db
          .select({
            gameId: catalogInputFields.gameId,
            key: catalogInputFields.key,
            options: catalogInputFields.options,
          })
          .from(catalogInputFields)
          .where(
            and(inArray(catalogInputFields.gameId, gameIds), isNull(catalogInputFields.archivedAt)),
          );
  const supplierOf = new Map(supplierList.map((supplier) => [supplier.id, supplier]));
  const priceOf = new Map(prices.map((row) => [row.productId, row]));
  const reviewOf = new Map(reviews.map((row) => [row.productId, row]));
  const keysOf = new Map<string, string[]>();
  const selectsOf = new Map<string, Record<string, string[]>>();
  for (const field of fields) {
    keysOf.set(field.gameId, [...(keysOf.get(field.gameId) ?? []), field.key]);
    if (field.options) {
      const selects = selectsOf.get(field.gameId) ?? {};
      selects[field.key] = field.options.map((option) => option.value);
      selectsOf.set(field.gameId, selects);
    }
  }

  for (const { product, ...where } of products) {
    const liveFieldKeys = keysOf.get(product.gameId) ?? [];
    const liveSelectOptions = selectsOf.get(product.gameId) ?? {};
    const routes: RouteState[] = routeRows
      .filter(({ route }) => route.productId === product.id)
      .map(({ route, offer }) => {
        const supplier = supplierOf.get(route.supplierId) as SupplierState;
        const balance = supplier.balance;
        const unusableReason = routeUnusableReason(
          {
            archived: route.archivedAt !== null,
            enabled: route.enabled,
            supplierCode: supplier.code,
            supplierAvailable: supplier.available,
            supplierConfigured: supplier.configured,
            supplierPaused: supplier.paused || supplier.subscriptionInactive,
            health: supplier.health,
            offerMissing: offer.missingSince !== null,
            offerUnsupported: offer.unsupportedReason !== null,
            kindMismatch: offer.kind !== null && offer.kind !== product.kind,
            offerMinQuantity: offer.minQuantity,
            offerMaxQuantity: offer.maxQuantity,
            productMaxQuantity: product.maxQuantity,
            inStock: offer.inStock,
            costUsdUnits: offer.costUsdUnits,
            costConfirmedAt: offer.costConfirmedAt,
            requiredFields: offer.requiredFields,
            fieldMap: route.fieldMap,
            optionMap: route.optionMap,
            fieldSpecs: offer.fieldSpecs,
            liveFieldKeys,
            liveSelectOptions,
            balanceUsdUnits: balance?.currency === 'USD' ? balance.amountUnits : null,
          },
          context.now,
          policy,
        );
        return {
          id: route.id,
          productId: route.productId,
          supplier,
          supplierCode: supplier.code,
          health: supplier.health,
          offer,
          costUsdUnits: offer.costUsdUnits,
          priority: route.priority,
          enabled: route.enabled,
          fieldMap: route.fieldMap,
          optionMap: route.optionMap,
          priceBasis: route.priceBasis,
          expectedDeliveryMinutes: route.expectedDeliveryMinutes,
          hardLimitMinutes: route.hardLimitMinutes,
          archivedAt: route.archivedAt,
          createdAt: route.createdAt,
          updatedAt: route.updatedAt,
          unusableReason,
          tier: unusableReason === null ? routeTier(supplier.code, supplier.health) : null,
          deliveryMedianMs: medians.get(supplier.id) ?? null,
        };
      });
    const usable = orderRoutes(routes.filter((route) => route.unusableReason === null));
    const others = [
      ...routes.filter((route) => route.unusableReason !== null && route.archivedAt === null),
      ...routes.filter((route) => route.archivedAt !== null),
    ];
    const current = priceOf.get(product.id) ?? null;
    const basis = priceBasis(usable, current !== null);
    const ruleRow = resolveMarginRule(rules, {
      productId: product.id,
      gameId: product.gameId,
      categoryId: where.categoryId,
    });
    const rule = {
      id: ruleRow.id,
      values: {
        percentBp: ruleRow.percentBp,
        fixedUsdUnits: ruleRow.fixedUsdUnits,
        minMarginUsdUnits: ruleRow.minMarginUsdUnits,
      },
    };
    states.set(product.id, {
      productId: product.id,
      nameAr: product.nameAr,
      kind: product.kind,
      gameId: product.gameId,
      categoryId: where.categoryId,
      routes: [...usable, ...others],
      basis,
      priceHeld: basis === null && usable.length > 0,
      rule,
      targetPriceUsdUnits: basis ? priceFromCost(basis.costUsdUnits as number, rule.values) : null,
      current,
      openReview: reviewOf.get(product.id) ?? null,
      availability: productAvailability({
        categoryArchived: where.categoryArchivedAt !== null,
        gameArchived: where.gameArchivedAt !== null,
        productArchived: product.archivedAt !== null,
        gameStatus: where.gameStatus,
        productStatus: product.status,
        price: current
          ? {
              priceUsdUnits: current.priceUsdUnits,
              minMarginUsdUnits: rule.values.minMarginUsdUnits,
            }
          : null,
        usableRouteCostsUsdUnits: usable.map((route) => route.costUsdUnits as number),
      }),
    });
  }
  return states;
}

/** Products with an unarchived route to one of these suppliers, to reprice after their change. */
export async function routedProductIds(
  db: Executor,
  supplierCodes: readonly SupplierCode[],
): Promise<string[]> {
  if (supplierCodes.length === 0) return [];
  const rows = await db
    .selectDistinct({ productId: productRoutes.productId })
    .from(productRoutes)
    .innerJoin(suppliers, eq(suppliers.id, productRoutes.supplierId))
    .where(and(isNull(productRoutes.archivedAt), inArray(suppliers.code, [...supplierCodes])));
  return rows.map((row) => row.productId);
}

/**
 * The price of the cheapest available product (S07 rule P9), or null when none is available: the
 * display step may add at most 2% to it.
 */
export async function cheapestAvailablePrice(
  db: Executor,
  context: RoutingContext,
): Promise<number | null> {
  const priced = await db
    .selectDistinct({ productId: productPrices.productId })
    .from(productPrices);
  const states = await productRoutingStates(
    db,
    priced.map((row) => row.productId),
    context,
  );
  let cheapest: number | null = null;
  for (const state of states.values()) {
    const price = state.current?.priceUsdUnits;
    if (state.availability !== 'available' || price === undefined) continue;
    if (cheapest === null || price < cheapest) cheapest = price;
  }
  return cheapest;
}
