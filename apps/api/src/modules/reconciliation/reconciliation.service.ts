import { Inject, Injectable } from '@nestjs/common';
import {
  isInternalCheck,
  isWarningResult,
  type OpenMismatch,
  QUEUES,
  RECONCILIATION_MANUAL_COOLDOWN_SECONDS,
  type ReconciliationDetails,
  type ReconciliationOverview,
  type ReconciliationResult,
  type ReconciliationRun,
  type ReconciliationRunDetail,
  type ReconciliationRunPage,
  type ReconciliationRunQuery,
  type ReconciliationSettings,
  type ShamCashCount,
  sypTolerance,
} from '@vertex-digital/contracts';
import {
  currentReconciliationSettings,
  type Database,
  failStaleRuns,
  newId,
  reconciliationExplanations,
  reconciliationResults,
  reconciliationRuns,
  reconciliationSettings,
  recordAudit,
  shamCashCountCheck,
} from '@vertex-digital/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService } from '../admin/index.js';
import { RatesService } from '../rates/index.js';

type RunRow = typeof reconciliationRuns.$inferSelect;
type ResultRow = typeof reconciliationResults.$inferSelect;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const running = () =>
  new CodedException(409, 'RECONCILIATION_RUNNING', 'A reconciliation run is running');

/** Rules RN2, RN6: one running run at a time, the partial unique index on `running`. */
const RUNNING_INDEX = 'reconciliation_runs_running_idx';

function toRun(row: RunRow): ReconciliationRun {
  return {
    id: row.id,
    trigger: row.trigger,
    businessDate: row.businessDate,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    mismatchCount: row.mismatchCount,
    warningCount: row.warningCount,
    recheckAt: row.recheckAt?.toISOString() ?? null,
    failure: row.failure,
  };
}

/**
 * The reconciliation (S13 rules RN1–RN9, E4, NT1): the overview, runs and results, the manual
 * run (queued for the worker), Sham Cash counts (checked at once), explanations and the
 * settings. Nothing here posts a journal or changes an order, a deposit or a wallet (rule RN9).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly admins: AdminAuthService,
    private readonly rates: RatesService,
    private readonly jobs: JobsService,
  ) {}

  async overview(): Promise<ReconciliationOverview> {
    const [lastNightly] = await this.db
      .select()
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.trigger, 'schedule'),
          sql`${reconciliationRuns.status} <> 'running'`,
        ),
      )
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(1);
    const [runningRun] = await this.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.status, 'running'))
      .limit(1);
    const [lastFinished] = await this.db
      .select({ id: reconciliationRuns.id })
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.status, 'finished'),
          sql`${reconciliationRuns.trigger} <> 'count'`,
        ),
      )
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(1);
    const warningRows = lastFinished
      ? (
          await this.db
            .select()
            .from(reconciliationResults)
            .where(eq(reconciliationResults.runId, lastFinished.id))
            .orderBy(reconciliationResults.check, reconciliationResults.subject)
        ).filter((row) => isWarningResult({ status: row.status, reason: detailsOf(row).reason }))
      : [];
    const counts = await this.db.execute<{
      subject: string;
      actual: string;
      at: Date;
      status: ResultRow['status'];
    }>(sql`
      select distinct on (subject) subject, actual_units::text as actual, created_at as at, status
      from reconciliation_results
      where "check" = 'sham_cash_count' and actual_units is not null
      order by subject, created_at desc, id desc`);
    const [lastManual] = await this.db
      .select({ startedAt: reconciliationRuns.startedAt })
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.trigger, 'manual'))
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(1);
    const availableAt = lastManual
      ? new Date(lastManual.startedAt.getTime() + RECONCILIATION_MANUAL_COOLDOWN_SECONDS * 1000)
      : null;
    return {
      lastNightly: lastNightly ? toRun(lastNightly) : null,
      running: runningRun ? toRun(runningRun) : null,
      openMismatches: await this.openMismatches(),
      warnings: await this.withExplanations(warningRows),
      shamCashCounts: counts.rows.map((row) => ({
        currency: row.subject === 'sham_cash_syp' ? 'SYP' : 'USD',
        countedUnits: Number(row.actual),
        at: new Date(row.at).toISOString(),
        status: row.status,
      })),
      settings: await currentReconciliationSettings(this.db),
      manualAvailableAt: availableAt && availableAt > new Date() ? availableAt.toISOString() : null,
    };
  }

  async runs(query: ReconciliationRunQuery): Promise<ReconciliationRunPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({ run: reconciliationRuns, at: cursorTime(reconciliationRuns.startedAt) })
      .from(reconciliationRuns)
      .where(
        and(
          query.trigger ? eq(reconciliationRuns.trigger, query.trigger) : undefined,
          cursor ? after(reconciliationRuns.startedAt, reconciliationRuns.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(reconciliationRuns.startedAt), desc(reconciliationRuns.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ run, at }) => ({ at, id: run.id }));
    return { items: page.items.map(({ run }) => toRun(run)), nextCursor: page.nextCursor };
  }

  async run(id: string): Promise<ReconciliationRunDetail> {
    const [row] = isUuid(id)
      ? await this.db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id))
      : [];
    if (!row) throw new CodedException(404, 'NOT_FOUND', 'No such run');
    return this.detail(row);
  }

  /** Rule RN2: a manual run, queued for the worker; one running, one per 5 minutes. */
  async startManual(adminId: string, meta: RequestMeta): Promise<ReconciliationRun> {
    const now = new Date();
    const row = await this.db
      .transaction(async (tx) => {
        // Manual starts queue on one lock, so the cooldown is read after the previous commit.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('reconciliation:manual'))`);
        const [last] = await tx
          .select({ startedAt: reconciliationRuns.startedAt })
          .from(reconciliationRuns)
          .where(eq(reconciliationRuns.trigger, 'manual'))
          .orderBy(desc(reconciliationRuns.startedAt))
          .limit(1);
        if (
          last &&
          now.getTime() - last.startedAt.getTime() < RECONCILIATION_MANUAL_COOLDOWN_SECONDS * 1000
        ) {
          throw new CodedException(429, 'RATE_LIMITED', 'At most one manual run per 5 minutes');
        }
        await failStaleRuns(tx, now);
        const [run] = await tx
          .insert(reconciliationRuns)
          .values({ trigger: 'manual', adminId })
          .returning();
        if (!run) throw new Error('The run was not written');
        await this.jobs.send(tx, QUEUES.reconciliationRun, { runId: run.id });
        await recordAudit(tx, {
          ...this.entry(adminId, meta, 'reconciliation_run', run.id),
          action: 'reconciliation_run.started',
          details: { runId: run.id, trigger: 'manual', currency: null, countedUnits: null },
        });
        return run;
      })
      .catch((error: unknown) => {
        throw violatedConstraint(error) === RUNNING_INDEX ? running() : error;
      });
    return toRun(row);
  }

  /**
   * Rules RN6, E4: a count is checked against the books at once, as a `count` run finished in the
   * same transaction. The key replays the count; another amount with the same key is refused.
   */
  async count(
    adminId: string,
    idempotencyKey: string,
    body: ShamCashCount,
    meta: RequestMeta,
  ): Promise<{ run: ReconciliationRunDetail; created: boolean }> {
    const replayed = await this.countForKey(idempotencyKey, body);
    if (replayed) return { run: replayed, created: false };
    const [settings, rate] = await Promise.all([
      currentReconciliationSettings(this.db),
      this.rates.current(),
    ]);
    const toleranceUnits =
      body.currency === 'USD'
        ? settings.toleranceUsdUnits
        : sypTolerance(settings.toleranceUsdUnits, rate?.sypPerUsd ?? null);
    const now = new Date();
    const runId = await this.db
      .transaction(async (tx) => {
        await failStaleRuns(tx, now);
        const id = newId();
        await tx
          .insert(reconciliationRuns)
          .values({ id, trigger: 'count', adminId, idempotencyKey });
        const result = await shamCashCountCheck(tx, {
          currency: body.currency,
          countedUnits: body.countedUnits,
          toleranceUnits,
        });
        await tx.insert(reconciliationResults).values({ runId: id, ...result });
        await tx
          .update(reconciliationRuns)
          .set({
            status: 'finished',
            finishedAt: new Date(),
            mismatchCount: result.status === 'mismatch' ? 1 : 0,
            warningCount: isWarningResult({ status: result.status, reason: result.details.reason })
              ? 1
              : 0,
          })
          .where(eq(reconciliationRuns.id, id));
        await recordAudit(tx, {
          ...this.entry(adminId, meta, 'reconciliation_run', id),
          action: 'reconciliation_run.started',
          details: {
            runId: id,
            trigger: 'count',
            currency: body.currency,
            countedUnits: body.countedUnits,
          },
        });
        return id;
      })
      .catch((error: unknown) => {
        const constraint = violatedConstraint(error);
        if (constraint === RUNNING_INDEX) throw running();
        if (constraint === 'reconciliation_runs_idempotency_key_unique') return null;
        throw error;
      });
    if (runId === null) {
      // The same key committed first, in parallel: answer its run.
      const replay = await this.countForKey(idempotencyKey, body);
      if (!replay) throw new Error('The key was taken but its run cannot be read');
      return { run: replay, created: false };
    }
    return { run: await this.run(runId), created: true };
  }

  /** Rule RN8: a note on the newest mismatch of its check and subject, once. */
  async explain(
    adminId: string,
    resultId: string,
    note: string,
    meta: RequestMeta,
  ): Promise<ReconciliationResult> {
    const [result] = isUuid(resultId)
      ? await this.db
          .select()
          .from(reconciliationResults)
          .where(eq(reconciliationResults.id, resultId))
      : [];
    if (!result) throw new CodedException(404, 'NOT_FOUND', 'No such result');
    const refused = () =>
      new CodedException(
        409,
        'RESULT_NOT_EXPLAINABLE',
        'Only the newest mismatch of its check and subject, not yet explained',
      );
    if (result.status !== 'mismatch') throw refused();
    await this.db
      .transaction(async (tx) => {
        const [newest] = await tx
          .select({ id: reconciliationResults.id })
          .from(reconciliationResults)
          .where(
            and(
              eq(reconciliationResults.check, result.check),
              eq(reconciliationResults.subject, result.subject),
            ),
          )
          .orderBy(desc(reconciliationResults.createdAt), desc(reconciliationResults.id))
          .limit(1);
        if (newest?.id !== result.id) throw refused();
        await tx.insert(reconciliationExplanations).values({ resultId: result.id, note, adminId });
        await recordAudit(tx, {
          ...this.entry(adminId, meta, 'reconciliation_result', result.id),
          reason: note,
          action: 'reconciliation_result.explained',
          details: {
            resultId: result.id,
            check: result.check,
            subject: result.subject,
            differenceUnits: result.differenceUnits,
          },
        });
      })
      .catch((error: unknown) => {
        throw violatedConstraint(error) === 'reconciliation_explanations_result_id_unique'
          ? refused()
          : error;
      });
    const [explained] = await this.withExplanations([result]);
    return explained as ReconciliationResult;
  }

  settings(): Promise<ReconciliationSettings> {
    return currentReconciliationSettings(this.db);
  }

  async updateSettings(
    adminId: string,
    body: ReconciliationSettings,
    meta: RequestMeta,
  ): Promise<ReconciliationSettings> {
    return this.db.transaction(async (tx) => {
      // Saves queue on one lock, so `before` is the version a parallel save replaced.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('reconciliation:settings'))`);
      const before = await currentReconciliationSettings(tx);
      const [row] = await tx
        .insert(reconciliationSettings)
        .values({ ...body, adminId })
        .returning({ id: reconciliationSettings.id });
      await recordAudit(tx, {
        ...this.entry(adminId, meta, 'reconciliation_settings', row?.id as string),
        action: 'reconciliation_settings.changed',
        details: { before, after: body },
      });
      return body;
    });
  }

  /** Rule RN7: the newest result of each check and subject, a mismatch not explained. */
  private async openMismatches(): Promise<OpenMismatch[]> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      select newest.id from (
        select distinct on ("check", subject) id, status
        from reconciliation_results
        order by "check", subject, created_at desc, id desc
      ) newest
      where newest.status = 'mismatch'
        and not exists (select 1 from reconciliation_explanations e where e.result_id = newest.id)`);
    if (rows.length === 0) return [];
    const results = await this.db
      .select()
      .from(reconciliationResults)
      .where(
        inArray(
          reconciliationResults.id,
          rows.map((row) => row.id),
        ),
      );
    const open: OpenMismatch[] = [];
    for (const result of await this.withExplanations(results)) {
      open.push({ ...result, firstSeenAt: await this.firstSeen(result) });
    }
    // Internal checks first, then the newest first.
    return open.sort(
      (a, b) =>
        Number(isInternalCheck(b.check)) - Number(isInternalCheck(a.check)) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  }

  /** When the check and subject started mismatching without a break. */
  private async firstSeen(result: ReconciliationResult): Promise<string> {
    const { rows } = await this.db.execute<{ at: Date | null }>(sql`
      select min(created_at) as at from reconciliation_results
      where "check" = ${result.check} and subject = ${result.subject}
        and created_at > coalesce((
          select max(created_at) from reconciliation_results
          where "check" = ${result.check} and subject = ${result.subject} and status <> 'mismatch'
        ), '-infinity')`);
    const at = rows[0]?.at;
    return at ? new Date(at).toISOString() : result.createdAt;
  }

  private async detail(row: RunRow): Promise<ReconciliationRunDetail> {
    const results = await this.db
      .select()
      .from(reconciliationResults)
      .where(eq(reconciliationResults.runId, row.id))
      .orderBy(reconciliationResults.createdAt, reconciliationResults.id);
    return { ...toRun(row), results: await this.withExplanations(results) };
  }

  private async countForKey(
    idempotencyKey: string,
    body: ShamCashCount,
  ): Promise<ReconciliationRunDetail | null> {
    const [row] = await this.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.idempotencyKey, idempotencyKey));
    if (!row) return null;
    const detail = await this.detail(row);
    const [result] = detail.results;
    if (result?.currency !== body.currency || result.actualUnits !== body.countedUnits) {
      throw new CodedException(409, 'IDEMPOTENCY_KEY_REUSED', 'The key was used for another count');
    }
    return detail;
  }

  private async withExplanations(rows: ResultRow[]): Promise<ReconciliationResult[]> {
    const explanations =
      rows.length === 0
        ? []
        : await this.db
            .select()
            .from(reconciliationExplanations)
            .where(
              inArray(
                reconciliationExplanations.resultId,
                rows.map((row) => row.id),
              ),
            );
    const names = await this.admins.namesOf([...new Set(explanations.map((row) => row.adminId))]);
    const byResult = new Map(explanations.map((row) => [row.resultId, row]));
    return rows.map((row) => {
      const explanation = byResult.get(row.id);
      return {
        id: row.id,
        runId: row.runId,
        check: row.check,
        subject: row.subject,
        status: row.status,
        currency: row.currency,
        booksUnits: row.booksUnits,
        actualUnits: row.actualUnits,
        differenceUnits: row.differenceUnits,
        allowedLowUnits: row.allowedLowUnits,
        allowedHighUnits: row.allowedHighUnits,
        offendingCount: row.offendingCount,
        details: detailsOf(row),
        explanation: explanation
          ? {
              note: explanation.note,
              adminName: names.get(explanation.adminId) ?? null,
              createdAt: explanation.createdAt.toISOString(),
            }
          : null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private entry(
    adminId: string,
    meta: RequestMeta,
    entityType: 'reconciliation_run' | 'reconciliation_result' | 'reconciliation_settings',
    entityId: string,
  ) {
    return {
      actorKind: 'admin',
      actorId: adminId,
      channel: 'admin',
      entityType,
      entityId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}

function detailsOf(row: ResultRow): ReconciliationDetails {
  return row.details as ReconciliationDetails;
}

