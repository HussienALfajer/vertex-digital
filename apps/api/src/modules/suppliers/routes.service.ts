import { Inject, Injectable } from '@nestjs/common';
import {
  type createRouteSchema,
  type ProductRouting,
  type Route,
  type UpdateRoute,
  unmappedFields,
} from '@vertex-digital/contracts';
import {
  type Database,
  newId,
  type ProductRoutingState,
  productRoutes,
  productRoutingStates,
  type RouteState,
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

const routeValues = (row: Pick<RouteRow, 'priority' | 'enabled' | 'fieldMap'>) => ({
  priority: row.priority,
  enabled: row.enabled,
  fieldMap: row.fieldMap,
});

function toRoute(route: RouteState, basisId: string | null): Route {
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
    },
    priority: route.priority,
    enabled: route.enabled,
    fieldMap: route.fieldMap,
    archivedAt: route.archivedAt?.toISOString() ?? null,
    tier: route.tier,
    unusableReason: route.unusableReason,
    basis: route.id === basisId,
    requirementsUnknown: offer.requiredFields === null,
  };
}

function toRouting(state: ProductRoutingState): ProductRouting {
  const basisId = state.basis?.id ?? null;
  const { current, openReview } = state;
  return {
    productId: state.productId,
    routes: state.routes.map((route) => toRoute(route, basisId)),
    basisRouteId: basisId,
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
 * A product's routes (S07 rules RT1–RT7): one per supplier, an offer serving one product, the
 * kind and the fields checked, manual offers with the admin's cost. Every change locks the
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
    const state = (await productRoutingStates(executor, [productId], routingContext(this.env))).get(
      productId,
    );
    if (!state) throw refusals.notFound('product');
    return toRouting(state);
  }

  /** Rules RT1–RT3: a route to an offer of an automatic supplier, enabled. */
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
        .where(eq(supplierOffers.id, input.offerId));
      if (!found) throw refusals.notFound('offer');
      const { offer, supplierCode } = found;
      if (offer.missingSince) throw refusals.offerMissing();
      if (offer.kind && offer.kind !== product.kind) throw refusals.kindMismatch();
      await this.checkFields(tx, product.gameId, offer.requiredFields, input.fieldMap, true);
      await this.checkFree(tx, product.id, offer.supplierId, offer.id);
      const [row] = await tx
        .insert(productRoutes)
        .values({
          id: newId(),
          productId: product.id,
          supplierId: offer.supplierId,
          offerId: offer.id,
          priority: input.priority,
          fieldMap: input.fieldMap,
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
      await this.checkFree(tx, product.id, supplierId, null);
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

  /** Priority, enable and field map; an enabled route needs its known fields mapped (RT3). */
  async update(actor: Actor, routeId: string, input: UpdateRoute): Promise<ProductRouting> {
    return this.changeRoute(routeId, async (tx, product, before) => {
      const after = {
        priority: input.priority ?? before.priority,
        enabled: input.enabled ?? before.enabled,
        fieldMap: input.fieldMap ?? before.fieldMap,
      };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
      );
      if (changed.length === 0) return;
      const [offer] = await tx
        .select({ requiredFields: supplierOffers.requiredFields })
        .from(supplierOffers)
        .where(eq(supplierOffers.id, before.offerId));
      await this.checkFields(
        tx,
        product.gameId,
        offer?.requiredFields ?? null,
        after.fieldMap,
        after.enabled,
      );
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

  /** Rule RT1 again: refused while another route holds the supplier or the offer. */
  async restore(actor: Actor, routeId: string): Promise<ProductRouting> {
    return this.changeRoute(routeId, async (tx, product, route, supplierCode) => {
      if (!route.archivedAt) return;
      await this.checkFree(tx, product.id, route.supplierId, route.offerId);
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
   * field the supplier requires.
   */
  private async checkFields(
    tx: Transaction,
    gameId: string,
    requiredFields: string[] | null,
    fieldMap: Record<string, string>,
    enabled: boolean,
  ): Promise<void> {
    const keys = new Set(await this.catalog.liveFieldKeys(tx, gameId));
    if (!Object.values(fieldMap).every((key) => keys.has(key))) {
      throw refusals.invalid('The field map names a field the game does not have');
    }
    const missing = unmappedFields(requiredFields, fieldMap);
    if (enabled && missing.length > 0) throw refusals.fieldsUnmapped(missing);
  }

  /** Rule RT1: no other unarchived route of the product to the supplier, or to the offer. */
  private async checkFree(
    tx: Transaction,
    productId: string,
    supplierId: string,
    offerId: string | null,
  ): Promise<void> {
    const [sameSupplier] = await tx
      .select({ id: productRoutes.id })
      .from(productRoutes)
      .where(
        and(
          eq(productRoutes.productId, productId),
          eq(productRoutes.supplierId, supplierId),
          isNull(productRoutes.archivedAt),
        ),
      );
    if (sameSupplier) throw refusals.routeExists();
    if (offerId === null) return;
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
      const names = await this.catalog.productNames([holder.productId]);
      throw refusals.offerMapped({
        productId: holder.productId,
        productNameAr: names.get(holder.productId)?.nameAr ?? '',
      });
    }
  }
}
