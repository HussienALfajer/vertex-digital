import { Inject, Injectable } from '@nestjs/common';
import {
  type createRouteSchema,
  type FieldSpec,
  type OptionMap,
  type ProductRouting,
  type Route,
  routeTimingValid,
  stockLevel,
  type UpdateRoute,
  unmappedFields,
  unmappedOptions,
} from '@vertex-digital/contracts';
import {
  currentOrderPolicy,
  currentSupplierPolicy,
  type Database,
  newId,
  type ProductRoutingState,
  productRoutes,
  productRoutingStates,
  type RouteState,
  readAll,
  repriceProducts,
  supplierCostChanges,
  supplierOffers,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { type Actor, CatalogItemsService, CatalogService } from '../catalog/index.js';
import { auditSuppliers, refusals, routeTakenRefusal } from './supplier-records.js';

type RouteRow = typeof productRoutes.$inferSelect;
type ProductRow = Awaited<ReturnType<CatalogItemsService['lockProduct']>>['row'];

const routeEntity = (id: string) => ({ type: 'product_route' as const, id });

type RouteValues = Pick<
  RouteRow,
  | 'priority'
  | 'enabled'
  | 'fieldMap'
  | 'optionMap'
  | 'priceBasis'
  | 'expectedDeliveryMinutes'
  | 'hardLimitMinutes'
>;

/** A route's settings as its audit entries record them (S07, S17). */
export const routeValues = (row: RouteValues): RouteValues => ({
  priority: row.priority,
  enabled: row.enabled,
  fieldMap: row.fieldMap,
  optionMap: row.optionMap,
  priceBasis: row.priceBasis,
  expectedDeliveryMinutes: row.expectedDeliveryMinutes,
  hardLimitMinutes: row.hardLimitMinutes,
});

function toRoute(route: RouteState, basisId: string | null, lowStockUnits: number): Route {
  const { offer } = route;
  return {
    id: route.id,
    supplierCode: route.supplierCode,
    supplierNameAr: route.supplier.nameAr,
    offer: {
      id: offer.id,
      offerId: offer.offerId,
      name: offer.name,
      kind: offer.kind,
      requiredFields: offer.requiredFields,
      costUsdUnits: offer.costUsdUnits,
      costConfirmedAt: offer.costConfirmedAt?.toISOString() ?? null,
      inStock: offer.inStock,
      missingSince: offer.missingSince?.toISOString() ?? null,
      stock: offer.stock,
      stockLevel: stockLevel(offer.stock, offer.inStock, lowStockUnits),
      fieldSpecs: offer.fieldSpecs,
    },
    priority: route.priority,
    enabled: route.enabled,
    fieldMap: route.fieldMap,
    optionMap: route.optionMap,
    priceBasis: route.priceBasis,
    expectedDeliveryMinutes: route.expectedDeliveryMinutes,
    hardLimitMinutes: route.hardLimitMinutes,
    archivedAt: route.archivedAt?.toISOString() ?? null,
    tier: route.tier,
    unusableReason: route.unusableReason,
    basis: route.id === basisId,
    requirementsUnknown: offer.requiredFields === null,
  };
}

function toRouting(state: ProductRoutingState, lowStockUnits: number): ProductRouting {
  const basisId = state.basis?.id ?? null;
  const { current, openReview } = state;
  return {
    productId: state.productId,
    routes: state.routes.map((route) => toRoute(route, basisId, lowStockUnits)),
    basisRouteId: basisId,
    priceHeld: state.priceHeld,
    currentPrice: current
      ? {
          priceUsdUnits: current.priceUsdUnits,
          costUsdUnits: current.costUsdUnits,
          routeId: current.routeId,
          createdAt: current.createdAt.toISOString(),
        }
      : null,
    targetPriceUsdUnits: state.targetPriceUsdUnits,
    openReview: openReview
      ? {
          id: openReview.id,
          costBeforeUsdUnits: openReview.costBeforeUsdUnits,
          costAfterUsdUnits: openReview.costAfterUsdUnits,
          changeBp: openReview.changeBp,
          proposedPriceUsdUnits: openReview.proposedPriceUsdUnits,
        }
      : null,
    availability: state.availability,
  };
}

/**
 * A product's routes (S07 rules RT1–RT7, S17 WR1): an offer serving one product, several routes
 * of one supplier allowed, the kind, the fields and the timing checked, manual offers with the
 * admin's cost. Every change locks the
 * product's game, then the product, and reprices it in the same transaction (rule P2, cause
 * `route_change`).
 */
@Injectable()
export class RoutesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly catalog: CatalogService,
    private readonly items: CatalogItemsService,
  ) {}

  /** `GET /api/admin/catalog/products/:id/routes`. */
  async routing(productId: string, executor: Database | Transaction = this.db) {
    const [states, policy] = await readAll(executor, [
      () => productRoutingStates(executor, [productId], routingContext(this.env)),
      () => currentSupplierPolicy(executor),
    ]);
    const state = states.get(productId);
    if (!state) throw refusals.notFound('product');
    return toRouting(state, policy.lowStockUnits);
  }

  /** Rules RT1–RT3: a route to an offer of an automatic supplier, enabled; never a manual one. */
  async create(
    actor: Actor,
    productId: string,
    input: z.output<typeof createRouteSchema>,
  ): Promise<ProductRouting> {
    return this.change(productId, async (tx, product) => {
      const [found] = await tx
        .select({ offer: supplierOffers, supplierCode: suppliers.code })
        .from(supplierOffers)
        .innerJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
        .where(eq(supplierOffers.id, input.offerId))
        // The lock an ignore waits on (S16 SC6): an offer ignored meanwhile is seen below.
        .for('key share', { of: supplierOffers });
      if (!found) throw refusals.notFound('offer');
      const { offer, supplierCode } = found;
      // A manual offer carries a cost the admin set for its own product (rule RT7): it is added
      // only by a manual route (re-authenticated) and comes back only with its route's restore.
      if (supplierCode === 'manual') {
        throw refusals.invalid('A manual offer serves only the product it was created for');
      }
      if (offer.missingSince) throw refusals.offerMissing();
      // S16 SC3, SC6: fields its adapter cannot send; an ignored offer is unignored first.
      if (offer.unsupportedReason) throw refusals.offerUnsupported();
      if (offer.ignoredAt) throw refusals.offerIgnored();
      if (offer.kind && offer.kind !== product.kind) throw refusals.kindMismatch();
      await this.checkFields(tx, product.gameId, offer, input, true);
      await this.checkTiming(tx, input);
      await this.checkFree(tx, product.id, offer.id);
      const [row] = await tx
        .insert(productRoutes)
        .values({
          id: newId(),
          productId: product.id,
          supplierId: offer.supplierId,
          offerId: offer.id,
          priority: input.priority,
          fieldMap: input.fieldMap,
          optionMap: input.optionMap,
          priceBasis: input.priceBasis,
          expectedDeliveryMinutes: input.expectedDeliveryMinutes,
          hardLimitMinutes: input.hardLimitMinutes,
        })
        .returning();
      const route = row as RouteRow;
      await auditSuppliers(tx, actor, 'product_route.created', routeEntity(route.id), {
        supplier: supplierCode,
        productId: product.id,
        offerId: offer.id,
        ...routeValues(route),
      });
    });
  }

  /**
   * Rule RT7: a manual offer named and kinded after the product, with the admin's cost and no
   * fields, and its route, in one transaction; the cost is recorded as a change by the admin.
   */
  async createManual(actor: Actor, productId: string, costUsdUnits: number) {
    return this.change(productId, async (tx, product) => {
      const [manual] = await tx.select().from(suppliers).where(eq(suppliers.code, 'manual'));
      const supplierId = (manual as { id: string }).id;
      const offerId = newId();
      const now = new Date();
      await tx.insert(supplierOffers).values({
        id: offerId,
        supplierId,
        offerId,
        name: product.nameAr,
        kind: product.kind,
        requiredFields: [],
        costUsdUnits,
        inStock: true,
        costConfirmedAt: now,
        lastSeenAt: now,
      });
      await tx.insert(supplierCostChanges).values({
        id: newId(),
        offerId,
        fromUsdUnits: null,
        toUsdUnits: costUsdUnits,
        adminId: actor.adminId,
      });
      const [row] = await tx
        .insert(productRoutes)
        .values({ id: newId(), productId: product.id, supplierId, offerId })
        .returning();
      const route = row as RouteRow;
      await auditSuppliers(tx, actor, 'product_route.created', routeEntity(route.id), {
        supplier: 'manual',
        productId: product.id,
        offerId,
        ...routeValues(route),
      });
      await auditSuppliers(
        tx,
        actor,
        'supplier_offer.manual_cost_set',
        {
          type: 'supplier_offer',
          id: offerId,
        },
        { productId: product.id, beforeUsdUnits: null, afterUsdUnits: costUsdUnits },
      );
    });
  }

  /**
   * Priority, enable, field map, (S16 MF2) option map and (S17) price basis and timing; an enabled
   * route needs its known fields mapped and its selects' options given supplier values (RT3), and
   * an expected time below its hard limit. A change of the price basis reprices at once (WR6).
   */
  async update(actor: Actor, routeId: string, input: UpdateRoute): Promise<ProductRouting> {
    return this.changeRoute(routeId, async (tx, product, before) => {
      const after = {
        priority: input.priority ?? before.priority,
        enabled: input.enabled ?? before.enabled,
        fieldMap: input.fieldMap ?? before.fieldMap,
        optionMap: input.optionMap ?? before.optionMap,
        priceBasis: input.priceBasis ?? before.priceBasis,
        expectedDeliveryMinutes:
          input.expectedDeliveryMinutes === undefined
            ? before.expectedDeliveryMinutes
            : input.expectedDeliveryMinutes,
        hardLimitMinutes:
          input.hardLimitMinutes === undefined ? before.hardLimitMinutes : input.hardLimitMinutes,
      };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
      );
      if (changed.length === 0) return;
      const [offer] = await tx
        .select({
          requiredFields: supplierOffers.requiredFields,
          fieldSpecs: supplierOffers.fieldSpecs,
        })
        .from(supplierOffers)
        .where(eq(supplierOffers.id, before.offerId));
      await this.checkFields(
        tx,
        product.gameId,
        { requiredFields: offer?.requiredFields ?? null, fieldSpecs: offer?.fieldSpecs ?? null },
        after,
        after.enabled,
      );
      if (changed.includes('expectedDeliveryMinutes') || changed.includes('hardLimitMinutes')) {
        await this.checkTiming(tx, after);
      }
      await tx.update(productRoutes).set(after).where(eq(productRoutes.id, routeId));
      const pick = (values: typeof after) =>
        Object.fromEntries(changed.map((key) => [key, values[key]]));
      await auditSuppliers(tx, actor, 'product_route.updated', routeEntity(routeId), {
        productId: product.id,
        before: pick(routeValues(before)),
        after: pick(after),
      });
    });
  }

  async archive(actor: Actor, routeId: string): Promise<ProductRouting> {
    return this.changeRoute(routeId, async (tx, product, route, supplierCode) => {
      if (route.archivedAt) return;
      await tx
        .update(productRoutes)
        .set({ archivedAt: new Date() })
        .where(eq(productRoutes.id, routeId));
      await auditSuppliers(tx, actor, 'product_route.archived', routeEntity(routeId), {
        supplier: supplierCode,
        productId: product.id,
      });
    });
  }

  /** Rule RT1 again: refused while another route holds the offer. */
  async restore(actor: Actor, routeId: string): Promise<ProductRouting> {
    return this.changeRoute(routeId, async (tx, product, route, supplierCode) => {
      if (!route.archivedAt) return;
      await this.checkFree(tx, product.id, route.offerId);
      await tx.update(productRoutes).set({ archivedAt: null }).where(eq(productRoutes.id, routeId));
      await auditSuppliers(tx, actor, 'product_route.restored', routeEntity(routeId), {
        supplier: supplierCode,
        productId: product.id,
      });
    });
  }

  /** Rule RT7: a manual offer's cost, recorded as a change and applied at once (no review). */
  async setManualCost(actor: Actor, routeId: string, costUsdUnits: number) {
    return this.changeRoute(routeId, async (tx, product, route, supplierCode) => {
      if (supplierCode !== 'manual') throw refusals.notFound('manual route');
      const [offer] = await tx
        .select()
        .from(supplierOffers)
        .where(eq(supplierOffers.id, route.offerId))
        .for('update');
      const before = offer?.costUsdUnits ?? null;
      if (before === costUsdUnits) return;
      await tx
        .update(supplierOffers)
        .set({ costUsdUnits, costConfirmedAt: new Date() })
        .where(eq(supplierOffers.id, route.offerId));
      await tx.insert(supplierCostChanges).values({
        id: newId(),
        offerId: route.offerId,
        fromUsdUnits: before,
        toUsdUnits: costUsdUnits,
        adminId: actor.adminId,
      });
      await auditSuppliers(
        tx,
        actor,
        'supplier_offer.manual_cost_set',
        {
          type: 'supplier_offer',
          id: route.offerId,
        },
        { productId: product.id, beforeUsdUnits: before, afterUsdUnits: costUsdUnits },
      );
    });
  }

  // Helpers ---------------------------------------------------------------------------------------

  /**
   * A route change of a product: its game, then the product locked (S06 order), the change, then
   * the product repriced (`route_change`) in the same transaction; answers the new routing. A
   * race on a route's unique index answers its refusal.
   */
  private async change(
    productId: string,
    work: (tx: Transaction, product: ProductRow) => Promise<void>,
  ): Promise<ProductRouting> {
    try {
      return await this.db.transaction(async (tx) => {
        const { row: product } = await this.items.lockProduct(tx, productId);
        await work(tx, product);
        await repriceProducts(tx, {
          productIds: [product.id],
          cause: 'route_change',
          context: routingContext(this.env),
        });
        return this.routing(product.id, tx);
      });
    } catch (error) {
      throw routeTakenRefusal(error) ?? error;
    }
  }

  /** `change` for an existing route, read again under its product's lock. */
  private async changeRoute(
    routeId: string,
    work: (
      tx: Transaction,
      product: ProductRow,
      route: RouteRow,
      supplierCode: RouteState['supplierCode'],
    ) => Promise<void>,
  ): Promise<ProductRouting> {
    const [found] = await this.db
      .select({ productId: productRoutes.productId })
      .from(productRoutes)
      .where(eq(productRoutes.id, routeId));
    if (!found) throw refusals.notFound('route');
    return this.change(found.productId, async (tx, product) => {
      const [row] = await tx
        .select({ route: productRoutes, supplierCode: suppliers.code })
        .from(productRoutes)
        .innerJoin(suppliers, eq(suppliers.id, productRoutes.supplierId))
        .where(eq(productRoutes.id, routeId));
      if (!row) throw refusals.notFound('route');
      await work(tx, product, row.route, row.supplierCode);
    });
  }

  /**
   * Rule RT3: the map names only unarchived fields of the game; an enabled route also maps each
   * field the supplier requires, and (S16 MF2) gives each option of a select it maps a value from
   * the supplier's list (`FIELD_OPTIONS_DIFFER`).
   */
  private async checkFields(
    tx: Transaction,
    gameId: string,
    offer: { requiredFields: string[] | null; fieldSpecs: FieldSpec[] | null },
    maps: { fieldMap: Record<string, string>; optionMap: OptionMap },
    enabled: boolean,
  ): Promise<void> {
    const keys = new Set(await this.catalog.liveFieldKeys(tx, gameId));
    if (!Object.values(maps.fieldMap).every((key) => keys.has(key))) {
      throw refusals.invalid('The field map names a field the game does not have');
    }
    if (!enabled) return;
    const missing = unmappedFields(offer.requiredFields, maps.fieldMap);
    if (missing.length > 0) throw refusals.fieldsUnmapped(missing);
    const selects = await this.catalog.liveSelectOptions(tx, gameId);
    const gaps = unmappedOptions(offer.fieldSpecs, maps.fieldMap, maps.optionMap, selects);
    if (gaps.length > 0) throw refusals.fieldOptionsDiffer(gaps);
  }

  /**
   * S17: the expected time is below the route's hard limit, or the policy's when it has none, at
   * the time of saving (`ROUTE_TIMING_INVALID`).
   */
  private async checkTiming(
    tx: Transaction,
    timing: { expectedDeliveryMinutes: number | null; hardLimitMinutes: number | null },
  ): Promise<void> {
    if (timing.expectedDeliveryMinutes === null) return;
    const policy = await currentOrderPolicy(tx);
    if (!routeTimingValid(timing, policy.hardLimitMinutes)) throw refusals.timingInvalid();
  }

  /** Rule RT1, S17 WR1: no other unarchived route to the offer. */
  private async checkFree(tx: Transaction, productId: string, offerId: string): Promise<void> {
    const [holder] = await tx
      .select({ productId: productRoutes.productId })
      .from(productRoutes)
      .where(
        and(
          eq(productRoutes.offerId, offerId),
          isNull(productRoutes.archivedAt),
          ne(productRoutes.productId, productId),
        ),
      );
    if (holder) {
      const names = await this.catalog.productNames([holder.productId], tx);
      throw refusals.offerMapped({
        productId: holder.productId,
        productNameAr: names.get(holder.productId)?.nameAr ?? '',
      });
    }
  }
}
