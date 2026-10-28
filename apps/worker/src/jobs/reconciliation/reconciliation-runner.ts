import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ExternalCheck,
  QUEUES,
  RECONCILIATION_RECHECK_MINUTES,
  REVIEW_TIME_ZONE,
  rawToUsdUnits,
  supplierPlace,
  type TreasuryPlace,
  USDT_METHODS,
  USDT_NETWORKS,
  type UsdtMethod,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  type CheckResult,
  countStaleCheck,
  currentReconciliationSettings,
  type Database,
  failReconciliationRun,
  failStaleRuns,
  finishReconciliationRun,
  openingRecorded,
  orderConflictsCheck,
  placeBooks,
  RECONCILIATION_RUN_OPTIONS,
  reconciliationResults,
  reconciliationRuns,
  runInternalChecks,
  type SupplierDayOrder,
  skippedResult,
  supplierBalanceCheck,
  supplierChargesCheck,
  supplierStates,
  type Transaction,
  usdtBalanceCheck,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { recordedCall } from '../../suppliers/supplier-calls.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';
import {
  CHAIN_READERS,
  ChainReaderError,
  type ChainReaders,
} from '../deposits/chain/chain-reader.js';
import { SupplierBalancesJob } from '../suppliers/balances.job.js';

/** S18 RC1: at most this many statement pages of a supplier's orders per run. */
const CHARGE_PAGES = 20;

type RunRow = typeof reconciliationRuns.$inferSelect;

/** A nightly run blocked by another run tries again this long after it may have ended. */
const NIGHTLY_WAIT_MS = 2 * 60_000;

/** One external check to run: what it reads, under the subject its result is stored. */
interface ExternalTarget {
  check: ExternalCheck;
  subject: string;
  read: (db: Database) => Promise<CheckResult | null>;
}

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: REVIEW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Rule RN1: the Damascus day a nightly run covers, the day that ended before the 00:30 cron. The
 * cron's data is fixed, so the job names it from its own start: the Damascus date 12 hours
 * earlier, which a late or retried job still gets right.
 */
export function nightlyBusinessDate(now: Date): string {
  return dateFormat.format(new Date(now.getTime() - 12 * 3_600_000));
}

/** `[start, end)` of a Damascus day, as instants. */
async function dayBounds(db: Database, date: string): Promise<{ from: Date; to: Date }> {
  const { rows } = await db.execute<{ from: Date; to: Date }>(sql`
    select (${date}::date::timestamp at time zone ${REVIEW_TIME_ZONE}) as "from",
      ((${date}::date + 1)::timestamp at time zone ${REVIEW_TIME_ZONE}) as "to"`);
  const row = rows[0];
  if (!row) throw new Error('No day bounds');
  return { from: new Date(row.from), to: new Date(row.to) };
}

/** A raw USDT balance in USD units, floored; a fake chain's scripted offset may go below zero. */
const usdUnitsOf = (raw: bigint, method: UsdtMethod) => {
  const decimals = USDT_NETWORKS[method].decimals;
  return raw < 0n ? -rawToUsdUnits(-raw, decimals) : rawToUsdUnits(raw, decimals);
};

/**
 * The reconciliation run (S13 rules RN1–RN9, C1–C9, E1–E6), shared by `reconciliation.run` and
 * `reconciliation.recheck`. It writes runs and results only: never a journal, an order, a deposit,
 * a wallet, a switch or a supplier (RN9). Each external check reads the outside balance first,
 * then the books in a fresh read (RN4); a result off its range is not stored but read again after
 * 10 minutes, and only the recheck's result is stored. The external checks a run still owes are
 * those of its targets without a result.
 */
@Injectable()
export class ReconciliationRunner {
  private readonly logger = new Logger(ReconciliationRunner.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly balances: SupplierBalancesJob,
    private readonly registry: SupplierRegistry,
    @Inject(CHAIN_READERS) private readonly readers: ChainReaders,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Rules RN1, RN5, edge case 4: the nightly run of `businessDate`, created once (stale runs
   * failed first); null when that night's run already ended. While another run is running, the
   * time to try again: after its recheck (rule RN4) or in two minutes.
   */
  async nightlyRun(
    businessDate: string,
    now = new Date(),
  ): Promise<string | null | { retryAt: Date }> {
    return this.db.transaction(async (tx) => {
      // One nightly run per day: concurrent creations queue on the day's lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`reconciliation:${businessDate}`}))`,
      );
      // The API's manual and count starts take this lock too: a manual run started at 00:30 is
      // seen as running here, never met as a unique violation that fails the job (audit A09-7).
      // Taken before any run row (the stale runs below), in the order the API takes them.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('reconciliation:start'))`);
      await failStaleRuns(tx, now);
      const [existing] = await tx
        .select({ id: reconciliationRuns.id, status: reconciliationRuns.status })
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.businessDate, businessDate));
      if (existing) return existing.status === 'running' ? existing.id : null;
      const [running] = await tx
        .select({ recheckAt: reconciliationRuns.recheckAt })
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.status, 'running'));
      if (running) {
        const after = Math.max(running.recheckAt?.getTime() ?? 0, now.getTime());
        return { retryAt: new Date(after + NIGHTLY_WAIT_MS) };
      }
      const [run] = await tx
        .insert(reconciliationRuns)
        .values({ trigger: 'schedule', businessDate })
        .returning({ id: reconciliationRuns.id });
      if (!run) throw new Error('The run was not written');
      return run.id;
    });
  }

  /**
   * Rules RN3–RN5: the internal checks in one snapshot, the warnings, then the external checks;
   * the run finishes, or waits for its recheck. Does nothing for a run that ended or already waits
   * (a second delivery of the same job).
   */
  async execute(runId: string, now = new Date()): Promise<void> {
    const run = await this.load(runId);
    if (run?.status !== 'running' || run.recheckAt !== null) return;
    const internal = await runInternalChecks(this.db);
    const settings = await currentReconciliationSettings(this.db);
    const day = await this.dayOf(run, now);
    const warnings = [
      await countStaleCheck(this.db, { now, staleDays: settings.countStaleDays }),
      await orderConflictsCheck(this.db, day),
    ];
    const external = await this.externalChecks(settings.toleranceUsdUnits, day, () => true);
    const kept = external.filter((result) => result.status !== 'mismatch');
    const recheck = kept.length < external.length;
    await this.db.transaction(async (tx) => {
      await this.store(tx, runId, [...internal.results, ...warnings, ...kept]);
      if (!recheck) {
        await tx
          .update(reconciliationRuns)
          .set({ snapshotPosition: internal.snapshotPosition })
          .where(eq(reconciliationRuns.id, runId));
        await finishReconciliationRun(tx, bossJobSender(this.pgBoss.boss), runId);
        return;
      }
      const recheckAt = new Date(now.getTime() + RECONCILIATION_RECHECK_MINUTES * 60_000);
      await tx
        .update(reconciliationRuns)
        .set({ snapshotPosition: internal.snapshotPosition, recheckAt })
        .where(eq(reconciliationRuns.id, runId));
      await bossJobSender(this.pgBoss.boss).send(
        tx,
        QUEUES.reconciliationRecheck,
        { runId },
        { singletonKey: runId, startAfter: recheckAt, ...RECONCILIATION_RUN_OPTIONS },
      );
    });
  }

  /**
   * Rule RN4: the external checks the run still owes (off their range at the first read) are read
   * again and stored as they are; then the run finishes.
   */
  async recheck(runId: string): Promise<void> {
    const run = await this.load(runId);
    if (run?.status !== 'running') return;
    const stored = await this.db
      .select({ check: reconciliationResults.check, subject: reconciliationResults.subject })
      .from(reconciliationResults)
      .where(eq(reconciliationResults.runId, runId));
    const done = new Set(stored.map((row) => `${row.check}|${row.subject}`));
    const settings = await currentReconciliationSettings(this.db);
    const results = await this.externalChecks(
      settings.toleranceUsdUnits,
      await this.dayOf(run, new Date()),
      (target) => !done.has(`${target.check}|${target.subject}`),
    );
    await this.db.transaction(async (tx) => {
      await this.store(tx, runId, results);
      await finishReconciliationRun(tx, bossJobSender(this.pgBoss.boss), runId);
    });
  }

  /** Rule RN5: the run failed after its last try, with the error's class and message. */
  async fail(runId: string, error: unknown): Promise<void> {
    const reported = withoutQueryParameters(error) as Error;
    const failure = `${reported.name}: ${reported.message}`;
    await this.db.transaction((tx) =>
      failReconciliationRun(tx, bossJobSender(this.pgBoss.boss), runId, failure),
    );
    this.logger.warn(`Reconciliation run ${runId} failed: ${failure}`);
  }

  /** The night's Damascus day; a manual run looks at the day so far. */
  private async dayOf(run: RunRow, now: Date): Promise<{ from: Date; to: Date }> {
    const day = await dayBounds(this.db, run.businessDate ?? dateFormat.format(now));
    return { from: day.from, to: run.businessDate ? day.to : now };
  }

  /**
   * S18 RC1: the supplier's orders created in `[from, to)`, newest first, page by page until one
   * reaches before the day (at most 20 pages); null when the statement cannot be read.
   */
  private async supplierDay(
    db: Database,
    supplier: { id: string; code: Parameters<SupplierRegistry['connect']>[1]['code'] },
    day: { from: Date; to: Date },
  ): Promise<SupplierDayOrder[] | null> {
    let connected: Awaited<ReturnType<SupplierRegistry['connect']>> = null;
    try {
      connected = await this.registry.connect(db, supplier);
    } catch {
      return null;
    }
    if (!connected?.adapter.capabilities.statement) return null;
    const { adapter } = connected;
    const orders: SupplierDayOrder[] = [];
    for (let page = 1; page <= CHARGE_PAGES; page += 1) {
      const read = await recordedCall(db, supplier.id, 'list_orders', () =>
        adapter.listOrders(page),
      );
      if (!read.ok) return null;
      for (const row of read.value.items) {
        if (!row.createdAt || row.createdAt < day.from || row.createdAt >= day.to) continue;
        orders.push({
          supplierOrderId: row.supplierOrderId,
          status: row.status ?? null,
          totalUnits: row.total?.currency === 'USD' ? row.total.amountUnits : null,
        });
      }
      const oldest = read.value.items.at(-1)?.createdAt;
      if (!read.value.hasMore || (oldest !== undefined && oldest < day.from)) return orders;
    }
    // The pages ran out before the day's start: a partial day would read as a false `ok`.
    return null;
  }

  private async load(runId: string): Promise<RunRow | undefined> {
    const [run] = await this.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, runId));
    return run;
  }

  /** Results are unique per run, check and subject: a second delivery stores nothing new. */
  private async store(tx: Transaction, runId: string, results: CheckResult[]): Promise<void> {
    if (results.length === 0) return;
    await tx
      .insert(reconciliationResults)
      .values(results.map((result) => ({ runId, ...result })))
      .onConflictDoNothing();
  }

  /** E2, E3: each target's outside read, then its books (RN4); in a fixed order. */
  private async externalChecks(
    toleranceUsdUnits: number,
    day: { from: Date; to: Date },
    wanted: (target: Pick<ExternalTarget, 'check' | 'subject'>) => boolean,
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const target of await this.targets(toleranceUsdUnits, day)) {
      const result = wanted(target) ? await target.read(this.db) : null;
      if (result) results.push(result);
    }
    return results;
  }

  /**
   * The external checks of this run: each supplier the balance job reads (configured, in this
   * build, not `manual`, rule E6) with a balance capability, and each network with a store
   * address. Internal checks never depend on them.
   */
  private async targets(
    toleranceUsdUnits: number,
    day: { from: Date; to: Date },
  ): Promise<ExternalTarget[]> {
    const targets: ExternalTarget[] = [];
    const now = new Date();
    const suppliers = await supplierStates(this.db, {
      fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
    });
    for (const supplier of suppliers) {
      if (supplier.code === 'manual' || !supplier.available || !supplier.configured) continue;
      const place = supplierPlace(supplier.code);
      targets.push({
        check: 'supplier_balance',
        subject: place,
        read: async (db) => {
          const outcome = await this.balances.read(db, supplier, now);
          // An adapter without a balance read has nothing to compare.
          if (outcome === null) return null;
          if (!outcome.ok) return this.readFailed(db, 'supplier_balance', place);
          if (outcome.balance.currency !== 'USD') {
            return skippedResult('supplier_balance', place, 'currency_unsupported');
          }
          return supplierBalanceCheck(db, {
            supplier: supplier.code,
            actualUnits: outcome.balance.amountUnits,
            toleranceUsdUnits,
          });
        },
      });
      // S18 RC1: what it charged for the day's orders, where its statement can be read.
      targets.push({
        check: 'supplier_charges',
        subject: place,
        read: async (db) => {
          const orders = await this.supplierDay(db, supplier, day);
          if (orders === null) return skippedResult('supplier_charges', place, 'reader_failed');
          return supplierChargesCheck(db, {
            supplier: supplier.code,
            orders,
            toleranceUsdUnits,
          });
        },
      });
    }
    for (const network of USDT_METHODS) {
      const address =
        network === 'usdt_trc20' ? this.env.USDT_TRC20_ADDRESS : this.env.USDT_BEP20_ADDRESS;
      if (!address) continue;
      targets.push({
        check: 'usdt_balance',
        subject: network,
        read: async (db) => {
          let raw: bigint;
          try {
            raw = await this.readers[network].getUsdtBalance(address);
          } catch (error) {
            // Rule RN4: a reader that fails concludes nothing; the next run tries again.
            if (!(error instanceof ChainReaderError)) throw error;
            this.logger.warn(`USDT balance of ${network} not read: ${error.message}`);
            return this.readFailed(db, 'usdt_balance', network);
          }
          return usdtBalanceCheck(db, {
            network,
            actualUnits: usdUnitsOf(raw, network),
            toleranceUsdUnits,
          });
        },
      });
    }
    return targets;
  }

  /** A failed read concludes nothing (RN4); `opening_missing` still wins while there is none. */
  private async readFailed(
    db: Database,
    check: 'supplier_balance' | 'usdt_balance',
    place: TreasuryPlace,
  ): Promise<CheckResult> {
    const books = await placeBooks(db, place);
    const reason = (await openingRecorded(db, place)) ? 'reader_failed' : 'opening_missing';
    return skippedResult(check, place, reason, books);
  }
}
