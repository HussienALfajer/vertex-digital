import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  formatSyp,
  formatUsd,
  isCostStale,
  type ProductKind,
  productKindSchema,
  QUEUES,
  SUPPLIER_COST_MAX_USD_UNITS,
  type SuppliersSyncPayload,
  supplierHasCatalog,
  suppliersSyncPayloadSchema,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  currentSupplierPolicy,
  type Database,
  newId,
  productPrices,
  productRoutes,
  productRoutingStates,
  queueTelegramMessage,
  repriceProducts,
  type SupplierState,
  supplierCostChanges,
  supplierOffers,
  supplierStates,
  supplierSyncRuns,
  type Transaction,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { SupplierError, type SupplierOffer } from '@vertex-digital/suppliers';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
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

/** Failed runs in a row before the admin is told (S07 "Jobs and integrations"). */
export const FAILING_SYNC_RUNS = 3;

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
    });
  }
  return [...listed.values()];
}

const sameFields = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (a !== null && b !== null && a.join('\n') === b.join('\n'));

/** The failed runs since the supplier's last successful one (for the failing-sync alerts). */
export async function failedRunStreak(
  db: Executor,
  supplierId: string,
): Promise<{ count: number; firstRunId: string | null; lastErrorCode: string | null }> {
  const [lastSuccess] = await db
    .select({ id: supplierSyncRuns.id })
    .from(supplierSyncRuns)
    .where(
      and(eq(supplierSyncRuns.supplierId, supplierId), eq(supplierSyncRuns.status, 'succeeded')),
    )
    .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
    .limit(1);
  const failed = and(
    eq(supplierSyncRuns.supplierId, supplierId),
    eq(supplierSyncRuns.status, 'failed'),
    lastSuccess
      ? // Compared in the database: a timestamp read back into JavaScript loses its microseconds.
        sql`(${supplierSyncRuns.startedAt}, ${supplierSyncRuns.id}) > (select started_at, id from ${supplierSyncRuns} where id = ${lastSuccess.id})`
      : undefined,
  );
  const [[total], [first], [last]] = await Promise.all([
    db.select({ count: count() }).from(supplierSyncRuns).where(failed),
    db
      .select({ id: supplierSyncRuns.id })
      .from(supplierSyncRuns)
      .where(failed)
      .orderBy(asc(supplierSyncRuns.startedAt), asc(supplierSyncRuns.id))
      .limit(1),
    db
      .select({ errorCode: supplierSyncRuns.errorCode })
      .from(supplierSyncRuns)
      .where(failed)
      .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
      .limit(1),
  ]);
  return {
    count: total?.count ?? 0,
    firstRunId: first?.id ?? null,
    lastErrorCode: last?.errorCode ?? null,
  };
}

class SuspiciousCatalog extends Error {}

/**
 * `suppliers.sync` (S07 rules SY1–SY4): one run at a time per supplier (the partial unique index on
 * running runs), one `listOffers` call recorded in `supplier_calls`, then, in one transaction, the
 * offers mirrored, their cost changes appended, the products on changed offers repriced (P2) and
 * the run closed with its counts. A failed run changes nothing but itself. No retries: the next
 * schedule tries again.
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
      return await this.apply(db, supplier, run, listedOffers(call.value));
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

  /** Rules SY3, SY4 and P2 in one transaction; throws `SuspiciousCatalog` to change nothing. */
  private async apply(
    db: Executor,
    supplier: SupplierState,
    run: SyncRunRow,
    listed: ListedOffer[],
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

      for (const offer of listed) {
        if (byOfferId.has(offer.offerId)) continue;
        await tx.insert(supplierOffers).values({
          id: newId(),
          supplierId: supplier.id,
          ...offer,
          costConfirmedAt: offer.costUsdUnits === null ? null : run.startedAt,
          lastSeenAt: run.startedAt,
        });
        counts.offersNew += 1;
      }
      for (const { row, offer } of updates) {
        await tx
          .update(supplierOffers)
          .set({
            name: offer.name,
            groupName: offer.groupName,
            kind: offer.kind,
            requiredFields: offer.requiredFields,
            costUsdUnits: offer.costUsdUnits,
            costRaw: offer.costRaw,
            inStock: offer.inStock,
            lastSeenAt: run.startedAt,
            ...(offer.costUsdUnits !== null && { costConfirmedAt: run.startedAt }),
            missingSince: null,
          })
          .where(eq(supplierOffers.id, row.id));
        if (row.costUsdUnits !== offer.costUsdUnits) {
          await tx.insert(supplierCostChanges).values({
            id: newId(),
            offerId: row.id,
            fromUsdUnits: row.costUsdUnits,
            toUsdUnits: offer.costUsdUnits,
            syncRunId: run.id,
          });
          counts.costsChanged += 1;
        }
      }
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
        })
        .where(and(eq(supplierSyncRuns.id, run.id), eq(supplierSyncRuns.status, 'running')))
        .returning();
      if (!closed) throw new Error(`Sync run ${run.id} is no longer running`);
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
