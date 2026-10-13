import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  FAILING_SYNC_RUNS,
  type FieldSpec,
  fieldSpecSchema,
  formatSyp,
  formatUsd,
  isCostStale,
  MAX_FIELD_SPECS,
  type OfferUnsupportedReason,
  offerUnsupportedReasonSchema,
  type ProductKind,
  productKindSchema,
  QUEUES,
  type StockLevel,
  SUPPLIER_COST_MAX_USD_UNITS,
  type SuppliersSyncPayload,
  stockAlertChange,
  supplierCategoryIdSchema,
  supplierHasCatalog,
  suppliersSyncPayloadSchema,
  TELEGRAM_STOCK_LOW_MAX_LINES,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  currentSupplierPolicy,
  type Database,
  failedRunStreak,
  mappedStockOffers,
  newId,
  productPrices,
  productRoutes,
  productRoutingStates,
  queueStoreRevalidate,
  queueTelegramMessage,
  repriceProducts,
  type SupplierState,
  supplierCategories,
  supplierCostChanges,
  supplierOffers,
  supplierStates,
  supplierSyncRuns,
  type Transaction,
  withoutQueryParameters,
} from '@vertex-digital/db';
import {
  type SupplierCategory,
  SupplierError,
  type SupplierOffer,
} from '@vertex-digital/suppliers';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { recordedCall, sanitizedMessage } from '../../suppliers/supplier-calls.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';

type Executor = Database | Transaction;
type SyncRunRow = typeof supplierSyncRuns.$inferSelect;
type OfferRow = typeof supplierOffers.$inferSelect;

/** A run left `running` this long was lost in a crash: the next run closes it (rule SY1). */
export const ABANDONED_RUN_MINUTES = 10;

const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** An offer as stored (rule SY2): text bounded, the cost in USD units or null with its raw value. */
export interface ListedOffer {
  offerId: string;
  name: string;
  groupName: string | null;
  kind: ProductKind | null;
  requiredFields: string[] | null;
  costUsdUnits: number | null;
  costRaw: string | null;
  inStock: boolean;
  /** S16 SC3, SF1, SF2. */
  categoryId: string | null;
  stock: number | null;
  originalCostUsdUnits: number | null;
  fieldSpecs: FieldSpec[] | null;
  unsupportedReason: OfferUnsupportedReason | null;
}

/** A category as stored (rule SC2): ids, text and counts bounded. */
export interface ListedCategory {
  categoryId: string;
  parentCategoryId: string | null;
  name: string;
  kind: ProductKind | null;
  productCount: number | null;
  inStockCount: number | null;
  imageUrl: string | null;
}

/** A count the supplier reports, or null when it is not a bounded whole number. */
const countOf = (value: number | undefined): number | null =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : null;

const categoryIdOf = (value: string | undefined): string | null =>
  supplierCategoryIdSchema.safeParse(value).data ?? null;

/**
 * Rule SC2: each category checked on its own: a usable id once (the first kept), a name of 1–200
 * characters, counts that are bounded whole numbers, an HTTPS image URL of at most 500.
 */
export function listedCategories(categories: readonly SupplierCategory[]): ListedCategory[] {
  const listed = new Map<string, ListedCategory>();
  for (const category of categories) {
    const categoryId = categoryIdOf(category.categoryId);
    const name = category.name?.trim().slice(0, 200);
    if (!categoryId || !name || listed.has(categoryId)) continue;
    const image = category.imageUrl;
    listed.set(categoryId, {
      categoryId,
      parentCategoryId: categoryIdOf(category.parentCategoryId),
      name,
      kind: productKindSchema.safeParse(category.kind).data ?? null,
      productCount: countOf(category.productCount),
      inStockCount: countOf(category.inStockCount),
      imageUrl: image?.startsWith('https://') && image.length <= 500 ? image : null,
    });
  }
  return [...listed.values()];
}

function rawCost(cost: SupplierOffer['cost']): string {
  try {
    return (cost.currency === 'USD' ? formatUsd : formatSyp)(cost.amountUnits).slice(0, 64);
  } catch {
    return `${cost.currency} ${String(cost.amountUnits)}`.slice(0, 64);
  }
}

/**
 * Rule SY2: each offer checked on its own. A cost is usable only in USD, above zero and at most
 * $10,000 (edge case 6); text is trimmed and bounded; an offer without a usable id is dropped, and
 * the first of two with one id is kept.
 */
export function listedOffers(offers: readonly SupplierOffer[]): ListedOffer[] {
  const listed = new Map<string, ListedOffer>();
  for (const offer of offers) {
    const offerId = String(offer.offerId ?? '').trim();
    if (offerId.length === 0 || offerId.length > 128 || listed.has(offerId)) continue;
    const { currency, amountUnits } = offer.cost;
    const usable =
      currency === 'USD' &&
      Number.isSafeInteger(amountUnits) &&
      amountUnits > 0 &&
      amountUnits <= SUPPLIER_COST_MAX_USD_UNITS;
    const group = offer.group?.trim().slice(0, 200);
    const fields = offer.requiredFields;
    const original = offer.originalCost;
    const originalUsable =
      original?.currency === 'USD' &&
      Number.isSafeInteger(original.amountUnits) &&
      original.amountUnits > 0 &&
      original.amountUnits <= SUPPLIER_COST_MAX_USD_UNITS;
    const specs = fieldSpecSchema.array().max(MAX_FIELD_SPECS).safeParse(offer.fieldSpecs);
    listed.set(offerId, {
      offerId,
      name: (offer.name?.trim() || offerId).slice(0, 200),
      groupName: group ? group : null,
      kind: productKindSchema.safeParse(offer.kind).data ?? null,
      requiredFields:
        fields && fields.length <= 10 && fields.every((field) => FIELD_NAME.test(field))
          ? [...fields]
          : null,
      costUsdUnits: usable ? amountUnits : null,
      costRaw: usable ? null : rawCost(offer.cost),
      inStock: offer.inStock === true,
      categoryId: categoryIdOf(offer.categoryId),
      stock: countOf(offer.stock),
      originalCostUsdUnits: originalUsable ? original.amountUnits : null,
      fieldSpecs: specs.success && offer.fieldSpecs !== undefined ? specs.data : null,
      unsupportedReason:
        offerUnsupportedReasonSchema.safeParse(offer.unsupportedReason).data ?? null,
    });
  }
  return [...listed.values()];
}

const sameFields = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (a !== null && b !== null && a.join('\n') === b.join('\n'));

class SuspiciousCatalog extends Error {}

/** Rows per statement when the sync writes offers and cost changes. */
const BATCH_SIZE = 500;

function* batches<T>(items: readonly T[]): Generator<T[]> {
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    yield items.slice(start, start + BATCH_SIZE);
  }
}

/**
 * Rule SY3 for listed offers already stored, in one statement: each row takes the listing's
 * values, is seen at the run's start and no longer missing; a usable cost is confirmed then.
 */
async function updateOffers(
  tx: Transaction,
  batch: readonly { row: OfferRow; offer: ListedOffer }[],
  seenAt: Date,
): Promise<void> {
  const values = batch.map(({ row, offer }) => ({
    id: row.id,
    name: offer.name,
    group_name: offer.groupName,
    kind: offer.kind,
    required_fields: offer.requiredFields,
    cost_usd_units: offer.costUsdUnits,
    cost_raw: offer.costRaw,
    in_stock: offer.inStock,
    category_id: offer.categoryId,
    stock: offer.stock,
    original_cost_usd_units: offer.originalCostUsdUnits,
    field_specs: offer.fieldSpecs,
    unsupported_reason: offer.unsupportedReason,
  }));
  await tx.execute(sql`
    update ${supplierOffers} as o set
      name = v.name,
      group_name = v.group_name,
      kind = v.kind,
      required_fields = v.required_fields,
      cost_usd_units = v.cost_usd_units,
      cost_raw = v.cost_raw,
      in_stock = v.in_stock,
      category_id = v.category_id,
      stock = v.stock,
      original_cost_usd_units = v.original_cost_usd_units,
      field_specs = v.field_specs,
      unsupported_reason = v.unsupported_reason,
      last_seen_at = ${seenAt}::timestamptz,
      cost_confirmed_at = case when v.cost_usd_units is null then o.cost_confirmed_at
        else ${seenAt}::timestamptz end,
      missing_since = null,
      updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as v(
      id uuid, name text, group_name text, kind product_kind, required_fields text[],
      cost_usd_units bigint, cost_raw text, in_stock boolean, category_id text, stock integer,
      original_cost_usd_units bigint, field_specs jsonb, unsupported_reason text
    )
    where o.id = v.id`);
}

/**
 * `suppliers.sync` (S07 rules SY1–SY4): one run at a time per supplier (the partial unique index on
 * running runs), one `listOffers` call recorded in `supplier_calls`, then, in one transaction, the
 * offers mirrored, their cost changes appended, the products on changed offers repriced (P2) and
 * the run closed with its counts and the store's refresh queued (S09 rule SF4). A failed run
 * changes nothing but itself. No retries: the next schedule tries again.
 */
@Injectable()
export class SupplierSyncJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierSyncJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly registry: SupplierRegistry,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<SuppliersSyncPayload>(QUEUES.suppliersSync, async (data) => {
      const run = await this.sync(suppliersSyncPayloadSchema.parse(data));
      if (run) this.logger.log(`Sync ${run.id} of ${data.supplierCode}: ${run.status}`);
    });
  }

  /** The finished run, or null when there was nothing to run (another run, a finished one). */
  async sync(payload: SuppliersSyncPayload, db: Executor = this.db): Promise<SyncRunRow | null> {
    const supplier = (
      await supplierStates(db, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED })
    ).find((state) => state.id === payload.supplierId);
    if (!supplier) return null;
    await this.closeAbandoned(db, supplier.id, payload.runId);
    const run = await this.start(db, supplier.id, payload);
    if (!run) return null;
    if (!supplier.configured) {
      return this.fail(db, supplier, run, 'SUPPLIER_NOT_CONFIGURED', 'No credentials');
    }
    if (!supplier.available || !supplierHasCatalog(supplier.code)) {
      return this.fail(db, supplier, run, 'SUPPLIER_UNAVAILABLE', 'No adapter in this build');
    }
    let secrets: string[] = [];
    try {
      const connected = await this.registry.connect(db, supplier);
      if (!connected) {
        return this.fail(db, supplier, run, 'SUPPLIER_UNAVAILABLE', 'No adapter in this build');
      }
      secrets = connected.secrets;
      // Rule SC2: categories first; a failed or empty read keeps the previous tree.
      let categories: ListedCategory[] | null = null;
      if (connected.adapter.capabilities.categories) {
        const read = await recordedCall(db, supplier.id, 'list_categories', () =>
          connected.adapter.listCategories(),
        );
        const listed = read.ok ? listedCategories(read.value) : [];
        if (listed.length > 0) categories = listed;
      }
      const call = await recordedCall(db, supplier.id, 'list_offers', () =>
        connected.adapter.listOffers(),
      );
      if (!call.ok) {
        const code =
          call.error instanceof SupplierError
            ? (call.error.details.supplierCode ??
              (call.error.kind === 'definitive' ? 'SUPPLIER_REFUSED' : 'SUPPLIER_ERROR'))
            : 'SUPPLIER_ERROR';
        return this.fail(db, supplier, run, code, sanitizedMessage(call.error, secrets));
      }
      const closed = await this.apply(db, supplier, run, listedOffers(call.value), {
        categories,
        skipped: connected.adapter.capabilities.categories === true && categories === null,
      });
      await this.alertLowStock(db, supplier, closed);
      return closed;
    } catch (error) {
      if (error instanceof SuspiciousCatalog) {
        return this.fail(db, supplier, run, 'CATALOG_SUSPICIOUS', error.message);
      }
      // Never a query's parameters (supplier text, ids) in the run, the logs or the alerts.
      const message = sanitizedMessage(withoutQueryParameters(error), secrets);
      await this.fail(db, supplier, run, 'INTERNAL', message);
      throw new Error(`Sync ${run.id} failed: ${message}`);
    }
  }

  /** Runs left `running` over 10 minutes by a crash, but the payload's own (rule SY1). */
  private async closeAbandoned(db: Executor, supplierId: string, keep?: string): Promise<void> {
    await db
      .update(supplierSyncRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorCode: 'ABANDONED',
        errorMessage: `Left running for over ${ABANDONED_RUN_MINUTES} minutes`,
      })
      .where(
        and(
          eq(supplierSyncRuns.supplierId, supplierId),
          eq(supplierSyncRuns.status, 'running'),
          lt(supplierSyncRuns.startedAt, new Date(Date.now() - ABANDONED_RUN_MINUTES * 60_000)),
          keep ? ne(supplierSyncRuns.id, keep) : undefined,
        ),
      );
  }

  /** The panel's run while it is running, or a new run unless another one is running. */
  private async start(
    db: Executor,
    supplierId: string,
    payload: SuppliersSyncPayload,
  ): Promise<SyncRunRow | null> {
    if (payload.runId) {
      const [run] = await db
        .select()
        .from(supplierSyncRuns)
        .where(and(eq(supplierSyncRuns.id, payload.runId), eq(supplierSyncRuns.status, 'running')));
      return run ?? null;
    }
    const [run] = await db
      .insert(supplierSyncRuns)
      .values({ id: newId(), supplierId, trigger: payload.trigger, startedAt: new Date() })
      .onConflictDoNothing()
      .returning();
    return run ?? null;
  }

  /** Closes the run as failed, and tells the admin at the third failure in a row. */
  private async fail(
    db: Executor,
    supplier: SupplierState,
    run: SyncRunRow,
    errorCode: string,
    errorMessage: string,
  ): Promise<SyncRunRow> {
    return db.transaction(async (tx) => {
      const [closed] = await tx
        .update(supplierSyncRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorCode: errorCode.slice(0, 64),
          errorMessage: errorMessage.slice(0, 500),
        })
        .where(and(eq(supplierSyncRuns.id, run.id), eq(supplierSyncRuns.status, 'running')))
        .returning();
      const streak = await failedRunStreak(tx, supplier.id);
      if (streak.count >= FAILING_SYNC_RUNS && streak.firstRunId) {
        await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
          kind: 'supplier_sync_failing',
          params: {
            reason: 'runs_failed',
            supplier: supplier.code,
            supplierNameAr: supplier.nameAr,
            failedRuns: streak.count,
            errorCode: streak.lastErrorCode,
          },
          dedupeKey: `sync-failing:${supplier.code}:${streak.firstRunId}`,
        });
      }
      return closed ?? run;
    });
  }

  /**
   * S16 SF2, after the run's commit: the mapped offers of active products whose stock level rose
   * since their stored alert get one `supplier_stock_low` message (up to 10 named, then a count);
   * an offer back at or above the threshold clears its alert. Offers no longer mapped to an active
   * product lose theirs, so a later drop alerts again.
   */
  private async alertLowStock(db: Executor, supplier: SupplierState, run: SyncRunRow) {
    await db.transaction(async (tx) => {
      const offers = await mappedStockOffers(tx, { supplierIds: [supplier.id], lock: true });
      const alerts: typeof offers = [];
      const changes = new Map<StockLevel | null, string[]>();
      for (const offer of offers) {
        const change = stockAlertChange(offer.stockAlert, offer.level);
        if (change.alert) alerts.push(offer);
        if (change.next !== offer.stockAlert) {
          changes.set(change.next, [...(changes.get(change.next) ?? []), offer.id]);
        }
      }
      for (const [level, ids] of changes) {
        await tx
          .update(supplierOffers)
          .set({ stockAlert: level })
          .where(inArray(supplierOffers.id, ids));
      }
      const mapped = offers.map((offer) => offer.id);
      await tx
        .update(supplierOffers)
        .set({ stockAlert: null })
        .where(
          and(
            eq(supplierOffers.supplierId, supplier.id),
            isNotNull(supplierOffers.stockAlert),
            mapped.length > 0
              ? sql`${supplierOffers.id} <> all(${sql.param(mapped)}::uuid[])`
              : undefined,
          ),
        );
      if (alerts.length === 0) return;
      await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
        kind: 'supplier_stock_low',
        params: {
          supplier: supplier.code,
          supplierNameAr: supplier.nameAr,
          runId: run.id,
          offers: alerts.slice(0, TELEGRAM_STOCK_LOW_MAX_LINES).map((offer) => ({
            gameNameAr: offer.gameNameAr,
            productNameAr: offer.productNameAr,
            level: offer.level === 'out' ? 'out' : 'low',
            stock: offer.stock,
          })),
          more: Math.max(0, alerts.length - TELEGRAM_STOCK_LOW_MAX_LINES),
        },
        dedupeKey: `stock:${run.id}`,
      });
    });
  }

  /**
   * Rule SC2: the tree upserted by `(supplier, category id)`, every listed node seen at the run's
   * start, and the nodes the read no longer lists marked missing since then. Links and ignores stay.
   */
  private async mirrorCategories(
    tx: Transaction,
    supplier: SupplierState,
    run: SyncRunRow,
    categories: ListedCategory[],
  ) {
    const seenAt = run.startedAt;
    for (let start = 0; start < categories.length; start += 500) {
      await tx
        .insert(supplierCategories)
        .values(
          categories.slice(start, start + 500).map((category) => ({
            id: newId(),
            supplierId: supplier.id,
            ...category,
            lastSeenAt: seenAt,
          })),
        )
        .onConflictDoUpdate({
          target: [supplierCategories.supplierId, supplierCategories.categoryId],
          set: {
            parentCategoryId: sql`excluded.parent_category_id`,
            name: sql`excluded.name`,
            kind: sql`excluded.kind`,
            productCount: sql`excluded.product_count`,
            inStockCount: sql`excluded.in_stock_count`,
            imageUrl: sql`excluded.image_url`,
            lastSeenAt: sql`excluded.last_seen_at`,
            missingSince: null,
            updatedAt: new Date(),
          },
        });
    }
    await tx
      .update(supplierCategories)
      .set({ missingSince: seenAt })
      .where(
        and(
          eq(supplierCategories.supplierId, supplier.id),
          isNull(supplierCategories.missingSince),
          lt(supplierCategories.lastSeenAt, seenAt),
        ),
      );
  }

  /** Rules SY3, SY4 and P2 in one transaction; throws `SuspiciousCatalog` to change nothing. */
  private async apply(
    db: Executor,
    supplier: SupplierState,
    run: SyncRunRow,
    listed: ListedOffer[],
    tree: { categories: ListedCategory[] | null; skipped: boolean },
  ): Promise<SyncRunRow> {
    const context = () => ({ now: new Date(), fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED });
    return db.transaction(async (tx) => {
      const [existing, routed, policy] = await Promise.all([
        tx
          .select()
          .from(supplierOffers)
          .where(eq(supplierOffers.supplierId, supplier.id))
          .orderBy(asc(supplierOffers.id))
          // Not `FOR UPDATE`: a route inserted by the panel takes `FOR KEY SHARE` on its offer
          // while it holds its game, which this transaction locks next (repricing).
          .for('no key update'),
        tx
          .selectDistinct({ offerId: productRoutes.offerId })
          .from(productRoutes)
          .where(and(eq(productRoutes.supplierId, supplier.id), isNull(productRoutes.archivedAt))),
        currentSupplierPolicy(tx),
      ]);
      const mapped = new Set(routed.map((row) => row.offerId));
      const listedById = new Map(listed.map((offer) => [offer.offerId, offer]));
      if (listed.length === 0) throw new SuspiciousCatalog('The supplier listed no offers');
      const mappedLive = existing.filter((row) => mapped.has(row.id) && row.missingSince === null);
      const vanishing = mappedLive.filter((row) => !listedById.has(row.offerId)).length;
      if (vanishing * 2 > mappedLive.length) {
        throw new SuspiciousCatalog(
          `${vanishing} of ${mappedLive.length} mapped offers would go missing`,
        );
      }

      const counts = { offersNew: 0, costsChanged: 0, offersMissing: 0, mappedMissing: 0 };
      const changed: string[] = [];
      const updates: { row: OfferRow; offer: ListedOffer }[] = [];
      const missing: OfferRow[] = [];
      const now = new Date();
      const byOfferId = new Map(existing.map((row) => [row.offerId, row]));
      for (const offer of listed) {
        const row = byOfferId.get(offer.offerId);
        if (!row) continue;
        updates.push({ row, offer });
        const moved =
          row.costUsdUnits !== offer.costUsdUnits ||
          row.inStock !== offer.inStock ||
          row.missingSince !== null ||
          row.kind !== offer.kind ||
          row.unsupportedReason !== offer.unsupportedReason ||
          !sameFields(row.requiredFields, offer.requiredFields) ||
          isCostStale(supplier.code, row.costConfirmedAt, now, policy);
        if (moved) changed.push(row.id);
      }
      for (const row of existing) {
        if (row.missingSince !== null || listedById.has(row.offerId)) continue;
        missing.push(row);
        changed.push(row.id);
      }
      const onChanged =
        changed.length === 0
          ? []
          : await tx
              .selectDistinct({ productId: productRoutes.productId })
              .from(productRoutes)
              .where(
                and(inArray(productRoutes.offerId, changed), isNull(productRoutes.archivedAt)),
              );
      // A route the panel created while the previous sync held these offers was priced on the
      // cost before that sync: its price is caught up here.
      const latest = tx
        .selectDistinctOn([productPrices.productId], {
          productId: productPrices.productId,
          routeId: productPrices.routeId,
          costUsdUnits: productPrices.costUsdUnits,
        })
        .from(productPrices)
        .orderBy(productPrices.productId, desc(productPrices.createdAt), desc(productPrices.id))
        .as('latest');
      const drifted = await tx
        .select({ productId: latest.productId })
        .from(latest)
        .innerJoin(productRoutes, eq(productRoutes.id, latest.routeId))
        .innerJoin(supplierOffers, eq(supplierOffers.id, productRoutes.offerId))
        .where(
          and(
            eq(supplierOffers.supplierId, supplier.id),
            isNull(productRoutes.archivedAt),
            isNotNull(supplierOffers.costUsdUnits),
            ne(supplierOffers.costUsdUnits, latest.costUsdUnits),
          ),
        );
      const productIds = [...new Set([...onChanged, ...drifted].map((row) => row.productId))];
      const before = await productRoutingStates(tx, productIds, context());

      // In batches: one statement per offer kept a WDG-sized catalog (11,000+ offers) writing for
      // minutes and grew the worker past its memory limit, so PM2 killed it mid-run.
      const fresh = listed.filter((offer) => !byOfferId.has(offer.offerId));
      for (const batch of batches(fresh)) {
        await tx.insert(supplierOffers).values(
          batch.map((offer) => ({
            id: newId(),
            supplierId: supplier.id,
            ...offer,
            costConfirmedAt: offer.costUsdUnits === null ? null : run.startedAt,
            lastSeenAt: run.startedAt,
          })),
        );
      }
      counts.offersNew = fresh.length;
      for (const batch of batches(updates)) {
        await updateOffers(tx, batch, run.startedAt);
      }
      const costChanges = updates.filter(
        ({ row, offer }) => row.costUsdUnits !== offer.costUsdUnits,
      );
      for (const batch of batches(costChanges)) {
        await tx.insert(supplierCostChanges).values(
          batch.map(({ row, offer }) => ({
            id: newId(),
            offerId: row.id,
            fromUsdUnits: row.costUsdUnits,
            toUsdUnits: offer.costUsdUnits,
            syncRunId: run.id,
          })),
        );
      }
      counts.costsChanged = costChanges.length;
      if (missing.length > 0) {
        await tx
          .update(supplierOffers)
          .set({ missingSince: run.startedAt })
          .where(
            inArray(
              supplierOffers.id,
              missing.map((row) => row.id),
            ),
          );
        counts.offersMissing = missing.length;
        counts.mappedMissing = missing.filter((row) => mapped.has(row.id)).length;
      }

      if (tree.categories) await this.mirrorCategories(tx, supplier, run, tree.categories);

      const repriced = await repriceProducts(tx, {
        productIds,
        cause: 'cost_sync',
        context: context(),
      });
      const after = await productRoutingStates(tx, productIds, context());
      const marginGuarded = productIds.filter(
        (id) =>
          after.get(id)?.availability === 'paused_by_margin_guard' &&
          before.get(id)?.availability !== 'paused_by_margin_guard',
      ).length;
      const [closed] = await tx
        .update(supplierSyncRuns)
        .set({
          status: 'succeeded',
          finishedAt: new Date(),
          offersSeen: listed.length,
          offersNew: counts.offersNew,
          costsChanged: counts.costsChanged,
          offersMissing: counts.offersMissing,
          reviewsOpened: repriced.reviewsOpened,
          productsRepriced: repriced.repriced,
          categoriesSkipped: tree.skipped,
        })
        .where(and(eq(supplierSyncRuns.id, run.id), eq(supplierSyncRuns.status, 'running')))
        .returning();
      if (!closed) throw new Error(`Sync run ${run.id} is no longer running`);
      // S09 rule SF4: costs, stock and prices the store shows may have changed.
      await queueStoreRevalidate(tx, bossJobSender(this.pgBoss.boss));
      if (repriced.reviewsOpened > 0 || marginGuarded > 0 || counts.mappedMissing > 0) {
        await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
          kind: 'supplier_sync_summary',
          params: {
            supplier: supplier.code,
            supplierNameAr: supplier.nameAr,
            runId: run.id,
            reviewsOpened: repriced.reviewsOpened,
            marginGuarded,
            mappedMissing: counts.mappedMissing,
          },
          dedupeKey: `sync:${run.id}`,
        });
      }
      return closed;
    });
  }
}
