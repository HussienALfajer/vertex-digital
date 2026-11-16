import { resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type DecisionFigure,
  decideRate,
  isFigureInRange,
  isFreshFigure,
  QUEUES,
  RATE_SOURCE_BROKEN_AFTER,
  RATE_SUGGESTION_TTL_HOURS,
  rateChangePercent,
  rateFromNumeric,
  rateSourceHealth,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  createSuggestion,
  type Database,
  driftBaseRate,
  type JobSender,
  lockRates,
  newestFigure,
  newestRate,
  newId,
  pendingSuggestion,
  queueTelegramMessage,
  rateObservations,
  rateSettingsInForce,
  rateSources,
  rateSuggestions,
  type Transaction,
  writeRate,
} from '@vertex-digital/db';
import { fileRateFetch, readRateSource } from '@vertex-digital/suppliers';
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** Every 5 minutes; a run reads the sources only when `poll_minutes` passed since the last read. */
export const RATES_POLL_CRON = '*/5 * * * *';

/** SR3: a source's health is judged on its newest reads. */
const READS_JUDGED = RATE_SOURCE_BROKEN_AFTER;

type SourceRow = typeof rateSources.$inferSelect;
type ReadRow = typeof rateObservations.$inferSelect;

export type RatesPollOutcome =
  | 'not_due'
  | 'no_sources'
  | 'no_rate'
  | 'none'
  | 'auto'
  | 'suggested'
  | 'rate_changed';

/**
 * `rates.poll` (S27 SR1–SR5, AU1–AU7), one run at a time (`singleton`). Reads each enabled source
 * once, outside any transaction (a failure is a stored read, never a job failure), stores one read
 * per source, then decides under the rate lock: nothing, an automatic rate with its silent notice,
 * or a suggestion card. Alerts are outbox rows with a dedupe key, so each is sent once per episode:
 * a broken source until it reads `ok` again, silent sources until a figure appears again. No rate
 * yet: nothing is read (edge case 11, the admin sets the first rate).
 */
@Injectable()
export class RatesPollJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(RatesPollJob.name);
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    this.fetchFn =
      env.RATE_FEED === 'live' ? fetch : fileRateFetch(resolve(env.RATE_FEED_FAKE_DIR));
    this.userAgent = `VertexDigitalRates/1.0 (+${env.STORE_URL})`;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.ratesPoll, async () => {
      const outcome = await this.poll();
      if (outcome === 'auto' || outcome === 'suggested') {
        this.logger.log(`Rate poll: ${outcome}`);
      }
    });
    await this.pgBoss.boss.schedule(QUEUES.ratesPoll, RATES_POLL_CRON);
    this.logger.log(`Scheduled ${QUEUES.ratesPoll} (${RATES_POLL_CRON})`);
  }

  /** One run at `now`; `jobs` lets a test record the outbox's jobs. */
  async poll(
    now = new Date(),
    db: Database | Transaction = this.db,
    jobs: JobSender = bossJobSender(this.pgBoss.boss),
  ): Promise<RatesPollOutcome> {
    const runStart = new Date();
    const sources = await db
      .select()
      .from(rateSources)
      .where(and(eq(rateSources.enabled, true), isNull(rateSources.archivedAt)));
    if (sources.length === 0) return 'no_sources';
    const current = await newestRate(db);
    if (!current) return 'no_rate';
    const { values: settings } = await rateSettingsInForce(db);
    if (!(await this.due(db, sources, now, settings.pollMinutes))) return 'not_due';
    const base = rateFromNumeric(current.sypPerUsd);
    for (const source of sources) {
      const read = await readRateSource(source, { fetch: this.fetchFn, userAgent: this.userAgent });
      const outOfRange =
        read.status === 'ok' && read.sypPerUsd !== null && !isFigureInRange(base, read.sypPerUsd);
      await db.insert(rateObservations).values({
        id: newId(),
        sourceId: source.id,
        fetchedAt: now,
        postedAt: read.postedAt,
        status: outOfRange ? 'out_of_range' : read.status,
        sypPerUsd: read.sypPerUsd,
        excerpt: read.excerpt,
        errorCode: read.errorCode,
      });
    }
    return db.transaction((tx) => this.decide(tx, jobs, sources, now, runStart));
  }

  /** SR1: due when no enabled source was read within `poll_minutes` (a minute's slack). */
  private async due(
    db: Database | Transaction,
    sources: SourceRow[],
    now: Date,
    pollMinutes: number,
  ): Promise<boolean> {
    const since = new Date(now.getTime() - (pollMinutes - 1) * 60_000);
    const [recent] = await db
      .select({ id: rateObservations.id })
      .from(rateObservations)
      .where(
        and(
          gte(rateObservations.fetchedAt, since),
          inArray(
            rateObservations.sourceId,
            sources.map((source) => source.id),
          ),
        ),
      )
      .limit(1);
    return !recent;
  }

  /** AU1–AU7 under the rate lock, with the alerts of SR3 and AU1. */
  private async decide(
    tx: Transaction,
    jobs: JobSender,
    sources: SourceRow[],
    now: Date,
    runStart: Date,
  ): Promise<RatesPollOutcome> {
    await lockRates(tx);
    const current = await newestRate(tx);
    const { values: settings } = await rateSettingsInForce(tx);
    if (!current) return 'no_rate';
    const figures: DecisionFigure[] = [];
    let lastSeen: Date | null = null;
    for (const source of sources) {
      await this.alertIfBroken(tx, jobs, source, await this.readsOf(tx, source.id));
      const figure = await newestFigure(tx, source.id);
      if (!figure?.read.sypPerUsd) continue;
      if (isFreshFigure(figure.seenAt, now, settings.freshnessMinutes)) {
        figures.push({
          observationId: figure.read.id,
          sypPerUsd: rateFromNumeric(figure.read.sypPerUsd),
        });
      }
      if (!lastSeen || figure.seenAt > lastSeen) lastSeen = figure.seenAt;
    }
    if (!lastSeen || now.getTime() - lastSeen.getTime() >= settings.silentAlertHours * 3_600_000) {
      // AU1: once per silence: the key names the newest figure the sources gave.
      await queueTelegramMessage(tx, jobs, {
        kind: 'rate_sources_silent',
        params: { hours: settings.silentAlertHours },
        dedupeKey: `rates:silent:${lastSeen?.toISOString() ?? 'never'}`,
      });
    }
    const currentRate = rateFromNumeric(current.sypPerUsd);
    const driftAt = new Date(now.getTime() - settings.driftWindowHours * 3_600_000);
    const driftBase = (await driftBaseRate(tx, driftAt)) ?? current;
    const pending = await pendingSuggestion(tx);
    const rejectedSince = new Date(now.getTime() - RATE_SUGGESTION_TTL_HOURS * 3_600_000);
    const rejected = await tx
      .select({ proposed: rateSuggestions.proposedSypPerUsd })
      .from(rateSuggestions)
      .where(
        and(eq(rateSuggestions.status, 'rejected'), gte(rateSuggestions.decidedAt, rejectedSince)),
      );
    const decision = decideRate({
      current: currentRate,
      driftBase: rateFromNumeric(driftBase.sypPerUsd),
      figures,
      settings,
      pending: pending && rateFromNumeric(pending.proposedSypPerUsd),
      rejected: rejected.map((row) => rateFromNumeric(row.proposed)),
    });
    if (decision.kind === 'none') return 'none';
    if (decision.kind === 'suggest') {
      await createSuggestion(tx, jobs, {
        sypPerUsd: decision.sypPerUsd,
        base: current,
        reason: decision.reason,
        observationIds: decision.observationIds,
        settings,
        now,
      });
      return 'suggested';
    }
    // AU7: a rate set since this run began (by hand, or a parallel run) wins over this decision.
    if (current.createdAt > runStart) return 'rate_changed';
    const { row } = await writeRate(
      tx,
      jobs,
      {
        sypPerUsd: decision.sypPerUsd,
        displayStepSypUnits: current.displayStepSypUnits,
        origin: 'auto',
        adminId: null,
        suggestionId: null,
        observationIds: decision.observationIds,
      },
      { actorKind: 'system', actorId: null, channel: 'worker' },
    );
    await queueTelegramMessage(tx, jobs, {
      kind: 'rate_auto_changed',
      params: {
        rateId: row.id,
        sypPerUsd: decision.sypPerUsd,
        changePercent: rateChangePercent(currentRate, decision.sypPerUsd),
        sources: decision.observationIds.length,
      },
      dedupeKey: `rates:auto:${row.id}`,
    });
    return 'auto';
  }

  /** SR3: one alert per broken episode, until the source reads `ok` again. */
  private async alertIfBroken(
    tx: Transaction,
    jobs: JobSender,
    source: SourceRow,
    reads: ReadRow[],
  ): Promise<void> {
    const [newest] = reads;
    if (!newest || newest.status === 'ok' || rateSourceHealth(reads) !== 'broken') return;
    const lastOk = reads.find((read) => read.status === 'ok');
    await queueTelegramMessage(tx, jobs, {
      kind: 'rate_source_broken',
      params: { sourceId: source.id, label: source.label, status: newest.status },
      dedupeKey: `rates:broken:${source.id}:${lastOk?.id ?? 'never'}`,
    });
  }

  private readsOf(tx: Transaction, sourceId: string): Promise<ReadRow[]> {
    return tx
      .select()
      .from(rateObservations)
      .where(eq(rateObservations.sourceId, sourceId))
      .orderBy(desc(rateObservations.fetchedAt), desc(rateObservations.id))
      .limit(READS_JUDGED);
  }
}
