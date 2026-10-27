import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  FAILING_SYNC_RUNS,
  HEALTH_ALERT_HOLD_MINUTES,
  HEALTH_PROBE_REASON,
  type HealthStanding,
  type HealthVerdict,
  healthReadStart,
  isCostStale,
  PANEL_READ_OPERATIONS,
  probeOutcome,
  QUEUES,
  ROOT_PRICE_LIST_IDS,
  type SupplierHealthState,
  type SupplierPolicy,
  supplierHasCatalog,
  supplierHealth,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  currentSupplierPolicy,
  type Database,
  failedRunStreak,
  newId,
  productPrices,
  productRoutes,
  productRoutingStates,
  queueStoreRevalidate,
  queueTelegramMessage,
  repriceProducts,
  routedProductIds,
  type SupplierState,
  supplierCalls,
  supplierHealthChanges,
  supplierOffers,
  supplierStates,
  suppliers,
  type Transaction,
  telegramMessages,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { and, asc, desc, eq, gte, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { recordedCall } from '../../suppliers/supplier-calls.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';

type Executor = Database | Transaction;

/** Every minute (rule H1). */
export const SUPPLIERS_HEALTH_CRON = '* * * * *';

/** No row yet: `healthy` since ever (rule H4). */
const NEVER = new Date(0);

/** A cost stale for less than this past its limit counts as newly stale (S09 rule SF4). */
const STALE_NEWS_MS = 2 * 60_000;

/**
 * `suppliers.health` (S07 rules H1–H4, SY5; S18 HE1–HE3, AL1–AL3), every minute: each available
 * supplier but `manual` (always healthy) is judged on its recorded calls; a `down` one is probed
 * after its wait. A change appends a `supplier_health_changes` row and reprices the supplier's
 * products at once; the admin is told once the new state has held 5 minutes (`down` at once), so
 * a short flap sends nothing.
 * Then the products whose price follows a stale cost are repriced, and a failing sync whose costs
 * went stale is reported once. Safe twice: a state is written only when it differs from the newest
 * row, read again under the supplier's row lock. A health change, and a cost newly stale, queue the
 * store's refresh (S09 rule SF4).
 */
@Injectable()
export class SupplierHealthJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierHealthJob.name);
  /**
   * Audit A05-17: the stale cost each product was last repriced on, by its confirmation time. A
   * product left on the same stale cost (no other usable route) is not locked and repriced again
   * every minute; a new confirmation, or a restart, reprices it once more.
   */
  private readonly repricedOnStale = new Map<string, number | null>();

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly registry: SupplierRegistry,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.suppliersHealth, async () => {
      await this.check();
    });
    await this.pgBoss.boss.schedule(QUEUES.suppliersHealth, SUPPLIERS_HEALTH_CRON);
    this.logger.log(`Scheduled ${QUEUES.suppliersHealth} (${SUPPLIERS_HEALTH_CRON})`);
  }

  async check(now = new Date(), db: Executor = this.db): Promise<void> {
    const policy = await currentSupplierPolicy(db);
    const states = await supplierStates(db, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED });
    // Audit A05-59: one supplier's failure leaves the others judged and the stale costs
    // repriced; the run then fails naming it, so pg-boss reports it.
    const failed: string[] = [];
    for (const supplier of states) {
      if (supplier.code === 'manual' || !supplier.available) continue;
      try {
        const verdict = await this.judge(db, supplier, policy, now);
        if (verdict) await this.change(db, supplier, verdict, now);
        await this.tell(db, supplier, now);
      } catch (error) {
        // In a caller's transaction (the tests) the failure has spoiled it: nothing else can run.
        if (db instanceof PgTransaction) throw error;
        const reported = withoutQueryParameters(error) as Error;
        this.logger.error(`Health of ${supplier.code} failed: ${reported.message}`);
        failed.push(supplier.code);
      }
    }
    await this.repriceStale(db, policy, now);
    for (const supplier of states) {
      if (supplier.available && supplierHasCatalog(supplier.code)) {
        await this.reportStale(db, supplier, policy, now);
      }
    }
    if (failed.length > 0) throw new Error(`Supplier health failed for ${failed.join(', ')}`);
  }

  private async standing(db: Executor, supplierId: string): Promise<HealthStanding> {
    const [row] = await db
      .select()
      .from(supplierHealthChanges)
      .where(eq(supplierHealthChanges.supplierId, supplierId))
      .orderBy(desc(supplierHealthChanges.createdAt), desc(supplierHealthChanges.id))
      .limit(1);
    return row
      ? { state: row.state, reason: row.reason, since: row.createdAt }
      : { state: 'healthy', reason: 'no change yet', since: NEVER };
  }

  /** Rules H1–H3: the supplier's state now, or null when it cannot be told (a down one waiting). */
  private async judge(
    db: Executor,
    supplier: SupplierState,
    policy: SupplierPolicy,
    now: Date,
  ): Promise<HealthVerdict | null> {
    const previous = await this.standing(db, supplier.id);
    if (previous.state !== 'down') {
      const calls = await db
        .select({
          operation: supplierCalls.operation,
          result: supplierCalls.result,
          latencyMs: supplierCalls.latencyMs,
          at: supplierCalls.createdAt,
        })
        .from(supplierCalls)
        .where(
          and(
            eq(supplierCalls.supplierId, supplier.id),
            // S18 HE2: the recovery check reads the windows of the last minutes too.
            gte(supplierCalls.createdAt, healthReadStart(previous, now, policy)),
            // S16 SF6: the panel's live reads never make a supplier degraded or down.
            notInArray(supplierCalls.operation, [...PANEL_READ_OPERATIONS]),
          ),
        )
        .orderBy(asc(supplierCalls.createdAt), asc(supplierCalls.id));
      return supplierHealth(calls, policy, previous, now);
    }
    const since = () =>
      db
        .select({ result: supplierCalls.result, at: supplierCalls.createdAt })
        .from(supplierCalls)
        .where(
          and(
            eq(supplierCalls.supplierId, supplier.id),
            gte(supplierCalls.createdAt, previous.since),
            notInArray(supplierCalls.operation, [...PANEL_READ_OPERATIONS]),
          ),
        )
        .orderBy(asc(supplierCalls.createdAt), asc(supplierCalls.id));
    const outcome = probeOutcome(previous.since, await since(), policy);
    const recovered =
      outcome.recoveredAt !== null ||
      (now >= outcome.nextProbeAt && supplier.configured && (await this.probe(db, supplier)));
    return recovered
      ? {
          state: 'degraded',
          reason: HEALTH_PROBE_REASON,
          calls: null,
          successBp: null,
          p90Ms: null,
        }
      : null;
  }

  /** Rule H3: one balance read, or a catalog read where there is no balance; true when answered. */
  private async probe(db: Executor, supplier: SupplierState): Promise<boolean> {
    let connected: Awaited<ReturnType<SupplierRegistry['connect']>>;
    try {
      connected = await this.registry.connect(db, supplier);
    } catch {
      this.logger.warn(`Cannot probe ${supplier.code}: its credentials do not decrypt`);
      return false;
    }
    if (!connected) return false;
    const { adapter } = connected;
    const call = adapter.capabilities.balance
      ? await recordedCall(db, supplier.id, 'get_balance', () => adapter.getBalance())
      : await recordedCall(db, supplier.id, 'list_offers', () => adapter.listOffers());
    // A refusal is an answer: the supplier is working (rule H1).
    return call.ok || call.result === 'refused';
  }

  /** Rule H4: the row and the repricing, once per change; the message waits (`tell`). */
  private async change(
    db: Executor,
    supplier: SupplierState,
    verdict: HealthVerdict,
    now: Date,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.id, supplier.id))
        // Not `FOR UPDATE`: a route inserted by the panel takes `FOR KEY SHARE` on its supplier.
        .for('no key update');
      const previous = await this.standing(tx, supplier.id);
      if (previous.state === verdict.state) return;
      const [row] = await tx
        .insert(supplierHealthChanges)
        .values({
          id: newId(),
          supplierId: supplier.id,
          state: verdict.state,
          reason: verdict.reason.slice(0, 200),
          calls: verdict.calls,
          successBp: verdict.successBp,
          p90Ms: verdict.p90Ms,
        })
        .returning({ id: supplierHealthChanges.id });
      await repriceProducts(tx, {
        productIds: await routedProductIds(tx, [supplier.code]),
        cause: 'route_change',
        context: { now, fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED },
      });
      if (!row) throw new Error(`No health change written for ${supplier.code}`);
      // S09 rule SF4: the store shows each game's service status and availability.
      await queueStoreRevalidate(tx, bossJobSender(this.pgBoss.boss));
      this.logger.log(`${supplier.code} is ${verdict.state}: ${verdict.reason}`);
    });
  }

  /**
   * S18 AL1–AL3: tells the admin the supplier's state once it differs from the last state told
   * and has held `HEALTH_ALERT_HOLD_MINUTES` (`down` at once). The message names the last state
   * told, so the admin's newest message always matches the state; one per change row.
   */
  private async tell(db: Executor, supplier: SupplierState, now: Date): Promise<void> {
    const current = await this.standingRow(db, supplier.id);
    if (!current) return;
    const [told] = await db
      .select({ state: sql<SupplierHealthState>`${telegramMessages.params} ->> 'state'` })
      .from(telegramMessages)
      .where(
        and(
          eq(telegramMessages.kind, 'supplier_health'),
          sql`${telegramMessages.params} ->> 'supplier' = ${supplier.code}`,
        ),
      )
      .orderBy(desc(telegramMessages.createdAt), desc(telegramMessages.id))
      .limit(1);
    const previous = told?.state ?? 'healthy';
    if (current.state === previous) return;
    const holdMs = current.state === 'down' ? 0 : HEALTH_ALERT_HOLD_MINUTES * 60_000;
    if (holdMs > 0 && now.getTime() - current.createdAt.getTime() < holdMs) return;
    await db.transaction((tx) =>
      queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
        kind: 'supplier_health',
        params: {
          supplier: supplier.code,
          supplierNameAr: supplier.nameAr,
          state: current.state,
          previous,
          successBp: current.successBp,
        },
        dedupeKey: `health:${current.id}`,
      }),
    );
  }

  private async standingRow(db: Executor, supplierId: string) {
    const [row] = await db
      .select()
      .from(supplierHealthChanges)
      .where(eq(supplierHealthChanges.supplierId, supplierId))
      .orderBy(desc(supplierHealthChanges.createdAt), desc(supplierHealthChanges.id))
      .limit(1);
    return row;
  }

  /**
   * Rule SY5: products whose price follows a cost that went stale move to their next usable route,
   * or become unavailable (P2, cause `route_change`). Manual costs never go stale.
   */
  private async repriceStale(db: Executor, policy: SupplierPolicy, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - policy.costStaleMinutes * 60_000);
    const latest = db
      .selectDistinctOn([productPrices.productId], {
        productId: productPrices.productId,
        routeId: productPrices.routeId,
      })
      .from(productPrices)
      .where(eq(productPrices.priceListId, ROOT_PRICE_LIST_IDS.retail))
      .orderBy(productPrices.productId, desc(productPrices.createdAt), desc(productPrices.id))
      .as('latest');
    const stale = await db
      .select({ productId: latest.productId, confirmedAt: supplierOffers.costConfirmedAt })
      .from(latest)
      .innerJoin(productRoutes, eq(productRoutes.id, latest.routeId))
      .innerJoin(supplierOffers, eq(supplierOffers.id, productRoutes.offerId))
      .innerJoin(suppliers, eq(suppliers.id, supplierOffers.supplierId))
      .where(
        and(
          ne(suppliers.code, 'manual'),
          or(isNull(supplierOffers.costConfirmedAt), lt(supplierOffers.costConfirmedAt, cutoff)),
        ),
      );
    const seen = (row: (typeof stale)[number]) => row.confirmedAt?.getTime() ?? null;
    const due = stale.filter(
      (row) =>
        !this.repricedOnStale.has(row.productId) ||
        this.repricedOnStale.get(row.productId) !== seen(row),
    );
    // Products no longer on a stale cost are forgotten, so a later staleness counts again.
    const staleIds = new Set(stale.map((row) => row.productId));
    for (const id of this.repricedOnStale.keys()) {
      if (!staleIds.has(id)) this.repricedOnStale.delete(id);
    }
    if (due.length === 0) return;
    // A cost that went stale since the last runs changes what the store shows; one stale for longer
    // was already refreshed (S09 rule SF4), so a failing sync does not refresh the store every minute.
    const newlyStale = due.some(
      (row) => row.confirmedAt && row.confirmedAt.getTime() >= cutoff.getTime() - STALE_NEWS_MS,
    );
    await this.repriceStaleProducts(
      db,
      due.map((row) => row.productId),
      newlyStale,
      now,
    );
    for (const row of due) this.repricedOnStale.set(row.productId, seen(row));
  }

  private async repriceStaleProducts(
    db: Executor,
    productIds: string[],
    newlyStale: boolean,
    now: Date,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const repriced = await repriceProducts(tx, {
        productIds,
        cause: 'route_change',
        context: { now, fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED },
      });
      if (newlyStale || repriced.repriced > 0) {
        await queueStoreRevalidate(tx, bossJobSender(this.pgBoss.boss));
      }
    });
  }

  /**
   * After three failed syncs in a row, once per run of failures: how many of the supplier's
   * products its stale costs left unavailable ("أسعار WDGZone قديمة: 14 باقة غير متوفرة").
   */
  private async reportStale(
    db: Executor,
    supplier: SupplierState,
    policy: SupplierPolicy,
    now: Date,
  ): Promise<void> {
    const streak = await failedRunStreak(db, supplier.id);
    if (streak.count < FAILING_SYNC_RUNS || !streak.firstRunId) return;
    const dedupeKey = `sync-stale:${supplier.code}:${streak.firstRunId}`;
    const [sent] = await db
      .select({ id: telegramMessages.id })
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, dedupeKey));
    if (sent) return;
    const states = await productRoutingStates(db, await routedProductIds(db, [supplier.code]), {
      now,
      fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
    });
    // A stale cost is read on its own: a route also unusable for an earlier reason (the supplier
    // down after the same failures) still has it, and keeps the product off once that reason ends.
    const unavailable = [...states.values()].filter(
      (state) =>
        state.availability === 'out_of_stock' &&
        state.routes.some(
          (route) =>
            route.supplierCode === supplier.code &&
            route.archivedAt === null &&
            route.enabled &&
            isCostStale(route.supplierCode, route.offer.costConfirmedAt, now, policy),
        ),
    ).length;
    if (unavailable === 0) return;
    await db.transaction((tx) =>
      queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
        kind: 'supplier_sync_failing',
        params: {
          reason: 'costs_stale',
          supplier: supplier.code,
          supplierNameAr: supplier.nameAr,
          unavailableProducts: unavailable,
        },
        dedupeKey,
      }),
    );
  }
}
