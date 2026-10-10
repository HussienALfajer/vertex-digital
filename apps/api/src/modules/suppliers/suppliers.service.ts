import { Inject, Injectable } from '@nestjs/common';
import {
  FAILING_SYNC_RUNS,
  type ImportOffers,
  type ImportResult,
  type ImportRowError,
  importOffersSchema,
  isCostStale,
  type OfferCostChangePage,
  type OfferListQuery,
  type PageQuery,
  QUEUES,
  type SetSupplierCredentials,
  SUPPLIER_CODES,
  SUPPLIER_CREDENTIAL_FIELDS,
  type SupplierCode,
  type SupplierDetail,
  type SupplierOfferPage,
  type SupplierPolicy,
  type SupplierSummary,
  type SuppliersSyncPayload,
  SYNC_REQUEST_INTERVAL_SECONDS,
  type SyncRun,
  type SyncRunPage,
  supplierHasCatalog,
  type UpdateSupplier,
  unmappedFields,
  type ValidationQuota,
} from '@vertex-digital/contracts';
import {
  credentialHints,
  currentSupplierPolicy,
  type Database,
  encryptCredentials,
  failedRunStreak,
  newId,
  productRoutes,
  productRoutingStates,
  repriceProducts,
  routedProducts,
  type SupplierState,
  supplierBalanceReads,
  supplierCostChanges,
  supplierCredentials,
  supplierHealthChanges,
  supplierKey,
  supplierOffers,
  supplierPolicy,
  supplierStates,
  supplierSyncRuns,
  suppliers,
  type Transaction,
  validationsToday,
} from '@vertex-digital/db';
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { JobsService } from '../../core/jobs/index.js';
import { type Actor, CatalogItemsService, CatalogService } from '../catalog/index.js';
import { SupplierAdaptersService } from './supplier-adapters.service.js';
import {
  auditSuppliers,
  type OfferRow,
  refusals,
  routeTakenRefusal,
  type SupplierRow,
  type SyncRunRow,
  toSyncRun,
} from './supplier-records.js';

/** A `LIKE` pattern that finds `text` anywhere, its wildcards taken literally. */
const containing = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

/** An offer has an unarchived route (rule RT1). */
const mapped = sql`exists (select 1 from ${productRoutes}
  where ${productRoutes.offerId} = ${supplierOffers.id} and ${productRoutes.archivedAt} is null)`;

const supplierEntity = (id: string) => ({ type: 'supplier' as const, id });

/**
 * Suppliers (S07 rules SP1–SP3, SY1, RT8, A07): credentials (encrypted, never returned), the
 * low-balance threshold, sync requests, offers and their costs, the import of offers into
 * products, and the policy. The only writer of the supplier tables in the API; the sync itself,
 * balances and health are the worker's.
 */
@Injectable()
export class SuppliersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly catalog: CatalogService,
    private readonly items: CatalogItemsService,
    private readonly adapters: SupplierAdaptersService,
  ) {}

  /** `GET /api/admin/suppliers`: `fake` only where it is enabled. */
  async list(): Promise<SupplierSummary[]> {
    const states = (await supplierStates(this.db, routingContext(this.env))).filter((state) =>
      this.visible(state.code),
    );
    return this.summaries(states);
  }

  /**
   * S11 rule DB6: the suppliers whose sync failed `FAILING_SYNC_RUNS` times since its last
   * success, as the failing-sync alert counts them.
   */
  async failingSyncs(): Promise<Set<SupplierCode>> {
    const rows = await this.db.select({ id: suppliers.id, code: suppliers.code }).from(suppliers);
    const streaks = await Promise.all(
      rows.map(async (row) => ({ ...row, streak: await failedRunStreak(this.db, row.id) })),
    );
    return new Set(
      streaks.filter((row) => row.streak.count >= FAILING_SYNC_RUNS).map((row) => row.code),
    );
  }

  /** `GET /api/admin/suppliers/:code`. */
  async detail(code: string): Promise<SupplierDetail> {
    const state = await this.state(code);
    const [[summary], credentials, health, balances] = await Promise.all([
      this.summaries([state]),
      this.db
        .select()
        .from(supplierCredentials)
        .where(eq(supplierCredentials.supplierId, state.id))
        .orderBy(desc(supplierCredentials.createdAt), desc(supplierCredentials.id))
        .limit(1),
      this.db
        .select()
        .from(supplierHealthChanges)
        .where(eq(supplierHealthChanges.supplierId, state.id))
        .orderBy(desc(supplierHealthChanges.createdAt), desc(supplierHealthChanges.id))
        .limit(20),
      this.db
        .select()
        .from(supplierBalanceReads)
        .where(eq(supplierBalanceReads.supplierId, state.id))
        .orderBy(desc(supplierBalanceReads.createdAt), desc(supplierBalanceReads.id))
        .limit(20),
    ]);
    const [credential] = credentials;
    return {
      ...(summary as SupplierSummary),
      credentialFields: [...SUPPLIER_CREDENTIAL_FIELDS[state.code]],
      credentials: credential
        ? { hints: credential.hints, setAt: credential.createdAt.toISOString() }
        : null,
      healthHistory: health.map((row) => ({
        id: row.id,
        state: row.state,
        reason: row.reason,
        calls: row.calls,
        successBp: row.successBp,
        p90Ms: row.p90Ms,
        createdAt: row.createdAt.toISOString(),
      })),
      balanceHistory: balances.map((row) => ({
        id: row.id,
        currency: row.currency,
        amountUnits: row.amountUnits,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Rule SP2: every field of the supplier, encrypted in a new row, audited by field names and
   * hints only; then the connection test, a sync, when the supplier can be synced.
   */
  async setCredentials(
    actor: Actor,
    code: string,
    input: SetSupplierCredentials,
  ): Promise<SupplierDetail> {
    const state = await this.state(code);
    const fields = SUPPLIER_CREDENTIAL_FIELDS[state.code];
    const given = Object.keys(input.values).sort();
    if (fields.length === 0 || given.join() !== [...fields].sort().join()) {
      throw refusals.invalid(`Expected exactly the fields ${fields.join(', ') || '(none)'}`);
    }
    const hints = credentialHints(input.values);
    await this.db.transaction(async (tx) => {
      const id = newId();
      await tx.insert(supplierCredentials).values({
        id,
        supplierId: state.id,
        ciphertext: encryptCredentials(
          supplierKey(this.env.SUPPLIER_KEYS_SECRET),
          state.id,
          input.values,
        ),
        hints,
        adminId: actor.adminId,
      });
      await auditSuppliers(tx, actor, 'supplier.credentials_set', supplierEntity(state.id), {
        supplier: state.code,
        fields: given,
        hints,
      });
      if (state.available && supplierHasCatalog(state.code)) {
        await this.startRun(tx, actor, state);
      }
    });
    return this.detail(code);
  }

  /** A07: the low-balance threshold. */
  async update(actor: Actor, code: string, input: UpdateSupplier): Promise<SupplierDetail> {
    const state = await this.state(code);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, state.id))
        .for('update');
      const before = (row as SupplierRow).lowBalanceUsdUnits;
      if (before === input.lowBalanceUsdUnits) return;
      await tx
        .update(suppliers)
        .set({ lowBalanceUsdUnits: input.lowBalanceUsdUnits })
        .where(eq(suppliers.id, state.id));
      await auditSuppliers(tx, actor, 'supplier.updated', supplierEntity(state.id), {
        supplier: state.code,
        before: { lowBalanceUsdUnits: before },
        after: { lowBalanceUsdUnits: input.lowBalanceUsdUnits },
      });
    });
    return this.detail(code);
  }

  /** S09 rule AD2: the supplier's daily validation quota, audited with before and after. */
  async setValidationQuota(
    actor: Actor,
    code: string,
    input: ValidationQuota,
  ): Promise<SupplierDetail> {
    const state = await this.state(code);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(suppliers)
        .where(eq(suppliers.id, state.id))
        .for('update');
      const before = (row as SupplierRow).validationDailyQuota;
      if (before === input.quota) return;
      await tx
        .update(suppliers)
        .set({ validationDailyQuota: input.quota })
        .where(eq(suppliers.id, state.id));
      await auditSuppliers(tx, actor, 'supplier.validation_quota_set', supplierEntity(state.id), {
        supplier: state.code,
        before,
        after: input.quota,
      });
    });
    return this.detail(code);
  }

  /**
   * Rule SY1, "sync now": the running run if there is one; otherwise a new run and its job, at
   * most one admin run a minute per supplier (`RATE_LIMITED`).
   */
  async requestSync(actor: Actor, code: string): Promise<SyncRun> {
    const state = await this.state(code);
    if (!state.configured) {
      throw new CodedException(409, 'SUPPLIER_NOT_CONFIGURED', 'Set the credentials first');
    }
    if (!state.available || !supplierHasCatalog(state.code)) {
      throw new CodedException(409, 'SUPPLIER_UNAVAILABLE', 'This supplier cannot be synced here');
    }
    const run = await this.db.transaction(async (tx) => {
      const [recent] = await tx
        .select({ startedAt: supplierSyncRuns.startedAt })
        .from(supplierSyncRuns)
        .where(
          and(eq(supplierSyncRuns.supplierId, state.id), eq(supplierSyncRuns.trigger, 'admin')),
        )
        .orderBy(desc(supplierSyncRuns.startedAt))
        .limit(1);
      const started = await this.startRun(tx, actor, state, recent?.startedAt);
      return started;
    });
    return toSyncRun(run, state.code);
  }

  /** `GET /api/admin/suppliers/:code/runs`: newest first. */
  async runs(code: string, page: PageQuery): Promise<SyncRunPage> {
    const state = await this.state(code);
    const where = eq(supplierSyncRuns.supplierId, state.id);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(supplierSyncRuns)
        .where(where)
        .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize),
      this.db.select({ total: count() }).from(supplierSyncRuns).where(where),
    ]);
    return {
      items: rows.map((row) => toSyncRun(row, state.code)),
      total: total?.total ?? 0,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /** `GET /api/admin/suppliers/:code/offers`: by name, with the product each one serves. */
  async offers(code: string, query: OfferListQuery): Promise<SupplierOfferPage> {
    const state = await this.state(code);
    const flag = (value: 'true' | 'false' | undefined, when: SQL) =>
      value === undefined ? undefined : value === 'true' ? when : sql`not (${when})`;
    const where = and(
      eq(supplierOffers.supplierId, state.id),
      query.q
        ? or(
            ilike(supplierOffers.name, containing(query.q)),
            ilike(supplierOffers.offerId, containing(query.q)),
          )
        : undefined,
      query.group ? eq(supplierOffers.groupName, query.group) : undefined,
      flag(query.mapped, mapped),
      flag(query.missing, isNotNull(supplierOffers.missingSince)),
      flag(query.inStock, eq(supplierOffers.inStock, true)),
    );
    const [rows, [total], policy] = await Promise.all([
      this.db
        .select()
        .from(supplierOffers)
        .where(where)
        .orderBy(supplierOffers.groupName, supplierOffers.name, supplierOffers.id)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(supplierOffers).where(where),
      currentSupplierPolicy(this.db),
    ]);
    const routes =
      rows.length === 0
        ? []
        : await this.db
            .select({
              id: productRoutes.id,
              offerId: productRoutes.offerId,
              productId: productRoutes.productId,
            })
            .from(productRoutes)
            .where(
              and(
                inArray(
                  productRoutes.offerId,
                  rows.map((row) => row.id),
                ),
                isNull(productRoutes.archivedAt),
              ),
            );
    const names = await this.catalog.productNames(routes.map((route) => route.productId));
    const routeOf = new Map(routes.map((route) => [route.offerId, route]));
    const now = new Date();
    return {
      items: rows.map((row) => {
        const route = routeOf.get(row.id);
        const product = route && names.get(route.productId);
        return {
          id: row.id,
          supplierCode: state.code,
          offerId: row.offerId,
          name: row.name,
          groupName: row.groupName,
          kind: row.kind,
          requiredFields: row.requiredFields,
          costUsdUnits: row.costUsdUnits,
          costRaw: row.costRaw,
          inStock: row.inStock,
          costConfirmedAt: row.costConfirmedAt?.toISOString() ?? null,
          costStale: isCostStale(state.code, row.costConfirmedAt, now, policy),
          lastSeenAt: row.lastSeenAt.toISOString(),
          missingSince: row.missingSince?.toISOString() ?? null,
          mapped:
            route && product
              ? {
                  routeId: route.id,
                  productId: route.productId,
                  productNameAr: product.nameAr,
                  gameId: product.gameId,
                  gameNameAr: product.gameNameAr,
                }
              : null,
        };
      }),
      total: total?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** `GET /api/admin/suppliers/offers/:id/costs`: newest first. */
  async offerCosts(offerId: string, page: PageQuery): Promise<OfferCostChangePage> {
    const [offer] = await this.db
      .select({ id: supplierOffers.id })
      .from(supplierOffers)
      .where(eq(supplierOffers.id, offerId));
    if (!offer) throw refusals.notFound('offer');
    const where = eq(supplierCostChanges.offerId, offerId);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(supplierCostChanges)
        .where(where)
        .orderBy(desc(supplierCostChanges.createdAt), desc(supplierCostChanges.id))
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize),
      this.db.select({ total: count() }).from(supplierCostChanges).where(where),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        fromUsdUnits: row.fromUsdUnits,
        toUsdUnits: row.toUsdUnits,
        syncRunId: row.syncRunId,
        byAdmin: row.adminId !== null,
        createdAt: row.createdAt.toISOString(),
      })),
      total: total?.total ?? 0,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * Rule RT8: up to 100 unmapped offers into paused products of one game, each with its enabled
   * route and its price, in one transaction. All or nothing: a refusal lists every refused row in
   * `details.rows`.
   */
  async importOffers(
    actor: Actor,
    code: string,
    input: z.output<typeof importOffersSchema>,
  ): Promise<ImportResult> {
    const state = await this.state(code);
    if (state.code === 'manual') {
      throw refusals.invalid('Manual offers are created by a manual route, never imported');
    }
    const ids = input.rows.map((row) => row.offerId);
    const game = await this.catalog.game(input.gameId);
    const liveKeys = new Set(
      game.fields.filter((field) => field.archivedAt === null).map((field) => field.key),
    );
    if (!Object.values(input.fieldMap).every((key) => liveKeys.has(key))) {
      throw refusals.invalid('The field map names a field the game does not have');
    }
    const offers = await this.db
      .select()
      .from(supplierOffers)
      .where(and(eq(supplierOffers.supplierId, state.id), inArray(supplierOffers.id, ids)));
    const offerOf = new Map(offers.map((offer) => [offer.id, offer]));
    const mappedIds = new Set(
      (
        await this.db
          .select({ offerId: productRoutes.offerId })
          .from(productRoutes)
          .where(and(inArray(productRoutes.offerId, ids), isNull(productRoutes.archivedAt)))
      ).map((row) => row.offerId),
    );
    const errors = input.rows.flatMap((row, index) => {
      const error = importRowError(offerOf.get(row.offerId), mappedIds, input);
      return error ? [{ index, ...error }] : [];
    });
    this.refuseRows(errors);
    const created = await this.db
      .transaction(async (tx) => {
        const products = await this.items.importProductsIn(
          tx,
          actor,
          game.id,
          input.rows.map((row) => {
            const offer = offerOf.get(row.offerId) as OfferRow;
            return { nameAr: row.nameAr, kind: offer.kind ?? input.kind ?? 'direct' };
          }),
        );
        const routes = products.map((product, index) => ({
          id: newId(),
          productId: product.id,
          supplierId: state.id,
          offerId: input.rows[index]?.offerId as string,
          fieldMap: input.fieldMap,
        }));
        await tx.insert(productRoutes).values(routes);
        for (const route of routes) {
          await auditSuppliers(tx, actor, 'product_route.created', routeEntity(route.id), {
            supplier: state.code,
            productId: route.productId,
            offerId: route.offerId,
            priority: 1,
            enabled: true,
            fieldMap: route.fieldMap,
          });
        }
        await auditSuppliers(tx, actor, 'supplier.import', supplierEntity(state.id), {
          supplier: state.code,
          gameId: game.id,
          count: products.length,
        });
        await repriceProducts(tx, {
          productIds: products.map((product) => product.id),
          cause: 'route_change',
          context: routingContext(this.env),
        });
        return { products, routes };
      })
      .catch((error: unknown) => {
        const taken = routeTakenRefusal(error);
        throw taken ?? error;
      });
    const states = await productRoutingStates(
      this.db,
      created.products.map((product) => product.id),
      routingContext(this.env),
    );
    return {
      products: created.products.map((product, index) => ({
        id: product.id,
        nameAr: product.nameAr,
        routeId: created.routes[index]?.id as string,
        priceUsdUnits: states.get(product.id)?.current?.priceUsdUnits ?? null,
      })),
    };
  }

  /** `GET /api/admin/suppliers/policy`. */
  policy(): Promise<SupplierPolicy> {
    return currentSupplierPolicy(this.db);
  }

  /**
   * A new policy row when it differs, audited with before and after; every routed product is
   * repriced, as staleness may change which routes are usable.
   */
  async setPolicy(actor: Actor, input: SupplierPolicy): Promise<SupplierPolicy> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('supplier_policy'))`);
      const before = await currentSupplierPolicy(tx);
      if (JSON.stringify(before) === JSON.stringify(input)) return;
      const id = newId();
      await tx.insert(supplierPolicy).values({ id, ...input, adminId: actor.adminId });
      await auditSuppliers(
        tx,
        actor,
        'supplier_policy.set',
        { type: 'supplier_policy', id },
        {
          before,
          after: input,
        },
      );
      await repriceProducts(tx, {
        productIds: await routedProducts(tx),
        cause: 'route_change',
        context: routingContext(this.env),
      });
    });
    return this.policy();
  }

  // Helpers ---------------------------------------------------------------------------------------

  private visible(code: SupplierCode): boolean {
    return code !== 'fake' || this.env.SUPPLIER_FAKE_ENABLED;
  }

  /** The supplier of a `:code`, or `NOT_FOUND` (`fake` too, where it is not enabled). */
  private async state(code: string): Promise<SupplierState> {
    const known = (SUPPLIER_CODES as readonly string[]).includes(code);
    const state = known
      ? (await supplierStates(this.db, routingContext(this.env))).find((row) => row.code === code)
      : undefined;
    if (!state || !this.visible(state.code)) throw refusals.notFound('supplier');
    return state;
  }

  /**
   * The running run, or a new `admin` run and its job, under the supplier's row lock. Refused
   * when the newest admin run began less than a minute ago.
   */
  private async startRun(
    tx: Transaction,
    actor: Actor,
    state: SupplierState,
    lastAdminStart?: Date,
  ): Promise<SyncRunRow> {
    await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.id, state.id))
      .for('update');
    const [running] = await tx
      .select()
      .from(supplierSyncRuns)
      .where(
        and(eq(supplierSyncRuns.supplierId, state.id), eq(supplierSyncRuns.status, 'running')),
      );
    if (running) return running;
    if (
      lastAdminStart &&
      Date.now() - lastAdminStart.getTime() < SYNC_REQUEST_INTERVAL_SECONDS * 1000
    ) {
      throw new CodedException(429, 'RATE_LIMITED', 'One sync request a minute per supplier');
    }
    const [run] = await tx
      .insert(supplierSyncRuns)
      .values({ id: newId(), supplierId: state.id, trigger: 'admin' })
      .returning();
    const created = run as SyncRunRow;
    const payload: SuppliersSyncPayload = {
      supplierId: state.id,
      supplierCode: state.code,
      trigger: 'admin',
      runId: created.id,
    };
    await this.jobs.send(tx, QUEUES.suppliersSync, payload);
    await auditSuppliers(tx, actor, 'supplier.sync_requested', supplierEntity(state.id), {
      supplier: state.code,
      runId: created.id,
    });
    return created;
  }

  private async summaries(states: SupplierState[]): Promise<SupplierSummary[]> {
    if (states.length === 0) return [];
    const ids = states.map((state) => state.id);
    const [runs, offers, mappedCounts, validations] = await Promise.all([
      this.db
        .selectDistinctOn([supplierSyncRuns.supplierId])
        .from(supplierSyncRuns)
        .where(inArray(supplierSyncRuns.supplierId, ids))
        .orderBy(
          supplierSyncRuns.supplierId,
          desc(supplierSyncRuns.startedAt),
          desc(supplierSyncRuns.id),
        ),
      this.db
        .select({ supplierId: supplierOffers.supplierId, total: count() })
        .from(supplierOffers)
        .where(inArray(supplierOffers.supplierId, ids))
        .groupBy(supplierOffers.supplierId),
      this.db
        .select({ supplierId: productRoutes.supplierId, total: count() })
        .from(productRoutes)
        .where(and(inArray(productRoutes.supplierId, ids), isNull(productRoutes.archivedAt)))
        .groupBy(productRoutes.supplierId),
      validationsToday(this.db, ids),
    ]);
    const runOf = new Map(runs.map((run) => [run.supplierId, run]));
    const offersOf = new Map(offers.map((row) => [row.supplierId, row.total]));
    const mappedOf = new Map(mappedCounts.map((row) => [row.supplierId, row.total]));
    return states.map((state) => {
      const run = runOf.get(state.id);
      const { balance } = state;
      return {
        code: state.code,
        nameAr: state.nameAr,
        available: state.available,
        configured: state.configured,
        paused: state.paused,
        health: state.health,
        healthSince: state.healthSince?.toISOString() ?? null,
        balance: balance
          ? {
              id: balance.id,
              currency: balance.currency,
              amountUnits: balance.amountUnits,
              createdAt: balance.createdAt.toISOString(),
            }
          : null,
        balanceLow:
          state.code !== 'manual' &&
          balance?.currency === 'USD' &&
          balance.amountUnits < state.lowBalanceUsdUnits,
        lowBalanceUsdUnits: state.lowBalanceUsdUnits,
        lastRun: run ? toSyncRun(run, state.code) : null,
        offerCount: offersOf.get(state.id) ?? 0,
        mappedCount: mappedOf.get(state.id) ?? 0,
        canValidatePlayer: this.adapters.canValidatePlayer(state.code),
        validationQuota: state.validationDailyQuota,
        validationsToday: validations.get(state.id) ?? 0,
      };
    });
  }

  /** Refuses an import with every refused row; the first row's code is the refusal's. */
  private refuseRows(errors: (ImportRowError & { fields?: string[] })[]): void {
    const [first] = errors;
    if (!first) return;
    const status =
      first.code === 'NOT_FOUND' ? 404 : first.code === 'VALIDATION_FAILED' ? 400 : 409;
    throw new CodedException(status, first.code as 'NOT_FOUND', 'Some rows cannot be imported', {
      rows: errors,
    });
  }
}

const routeEntity = (id: string) => ({ type: 'product_route' as const, id });

/** Why an import row is refused (rules RT1–RT3, RT8), or null. */
function importRowError(
  offer: OfferRow | undefined,
  mappedIds: ReadonlySet<string>,
  input: Pick<ImportOffers, 'kind' | 'fieldMap'>,
): { code: string; fields?: string[] } | null {
  if (!offer) return { code: 'NOT_FOUND' };
  if (mappedIds.has(offer.id)) return { code: 'OFFER_ALREADY_MAPPED' };
  if (offer.missingSince) return { code: 'OFFER_MISSING' };
  if (offer.kind && input.kind && offer.kind !== input.kind) return { code: 'ROUTE_KIND_MISMATCH' };
  const fields = unmappedFields(offer.requiredFields, input.fieldMap ?? {});
  if (fields.length > 0) return { code: 'ROUTE_FIELDS_UNMAPPED', fields };
  if (!offer.kind && !input.kind) return { code: 'VALIDATION_FAILED' };
  return null;
}
