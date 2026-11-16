import { resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateRateSource,
  isFigureInRange,
  isRateSourceHandle,
  normaliseRateSourceHandle,
  type RateSource,
  type RateSourceList,
  type RateSourceTestResult,
  rateFromNumeric,
  type TestRateSource,
  type UpdateRateSource,
} from '@vertex-digital/contracts';
import {
  type Database,
  newestRate,
  newId,
  rateObservations,
  rateSources,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { fileRateFetch, readRateSource } from '@vertex-digital/suppliers';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { toSourceRecord } from './rate-records.js';

/** The panel shows each source's last three reads (S27 `/rates`). */
const SHOWN_READS = 3;

type SourceRow = typeof rateSources.$inferSelect;

const invalid = (message: string) => new CodedException(400, 'RATE_SOURCE_INVALID', message);

/**
 * S27 rate sources: the panel's list, add, edit, archive and test read. The hosts are fixed in
 * `packages/suppliers` (`readRateSource`); a source holds only a channel username or a page path.
 */
@Injectable()
export class RateSourcesService {
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
  ) {
    this.fetchFn =
      env.RATE_FEED === 'live' ? fetch : fileRateFetch(resolve(env.RATE_FEED_FAKE_DIR));
    this.userAgent = `VertexDigitalRates/1.0 (+${env.STORE_URL})`;
  }

  /** `GET /api/admin/rate-sources`: live sources, oldest first, each with its last reads. */
  async list(): Promise<RateSourceList> {
    const rows = await this.db
      .select()
      .from(rateSources)
      .where(isNull(rateSources.archivedAt))
      .orderBy(asc(rateSources.createdAt), asc(rateSources.id));
    const reads = await this.readsOf(
      this.db,
      rows.map((row) => row.id),
    );
    return { items: rows.map((row) => toSourceRecord(row, reads.get(row.id) ?? [])) };
  }

  async create(adminId: string, input: CreateRateSource, meta: RequestMeta): Promise<RateSource> {
    const row = await this.write(() =>
      this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(rateSources)
          .values({ id: newId(), ...input })
          .returning();
        if (!created) throw new Error('The source was not written');
        await recordAudit(tx, {
          action: 'rate_source.created',
          actorKind: 'admin',
          actorId: adminId,
          channel: 'admin',
          entityType: 'rate_source',
          entityId: created.id,
          details: { sourceId: created.id, ...input },
          ...meta,
        });
        return created;
      }),
    );
    return toSourceRecord(row, []);
  }

  async update(
    adminId: string,
    id: string,
    input: UpdateRateSource,
    meta: RequestMeta,
  ): Promise<RateSource> {
    const row = await this.write(() =>
      this.db.transaction(async (tx) => {
        const before = await this.lockLive(tx, id);
        if (input.handle !== undefined) {
          const handle = normaliseRateSourceHandle(before.kind, input.handle);
          if (!isRateSourceHandle(before.kind, handle)) {
            throw invalid('The handle does not fit the source kind');
          }
          input = { ...input, handle };
        }
        const changed = (Object.keys(input) as (keyof UpdateRateSource)[]).filter(
          (key) => JSON.stringify(input[key]) !== JSON.stringify(before[key]),
        );
        if (changed.length === 0) return before;
        const [after] = await tx
          .update(rateSources)
          .set(input)
          .where(eq(rateSources.id, id))
          .returning();
        if (!after) throw new Error('The source was not updated');
        const pick = (from: SourceRow) =>
          Object.fromEntries(changed.map((key) => [key, from[key]]));
        await recordAudit(tx, {
          action: 'rate_source.updated',
          actorKind: 'admin',
          actorId: adminId,
          channel: 'admin',
          entityType: 'rate_source',
          entityId: id,
          details: { sourceId: id, before: pick(before), after: pick(after) },
          ...meta,
        });
        return after;
      }),
    );
    return toSourceRecord(row, (await this.readsOf(this.db, [row.id])).get(row.id) ?? []);
  }

  /** Archives a source: it is never read again; its reads stay until their purge. */
  async archive(adminId: string, id: string, meta: RequestMeta): Promise<RateSource> {
    const row = await this.db.transaction(async (tx) => {
      const before = await this.lockLive(tx, id);
      const [archived] = await tx
        .update(rateSources)
        .set({ archivedAt: sql`now()`, enabled: false })
        .where(eq(rateSources.id, id))
        .returning();
      if (!archived) throw new Error('The source was not archived');
      await recordAudit(tx, {
        action: 'rate_source.archived',
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'rate_source',
        entityId: id,
        details: { sourceId: id, label: before.label },
        ...meta,
      });
      return archived;
    });
    return toSourceRecord(row, []);
  }

  /**
   * `POST /api/admin/rate-sources/test`: reads the page once and stores nothing (edge case 10).
   * A figure more than 20% from the current rate reads as `out_of_range` (SR3).
   */
  async test(input: TestRateSource): Promise<RateSourceTestResult> {
    const read = await readRateSource(input, { fetch: this.fetchFn, userAgent: this.userAgent });
    const current = await newestRate(this.db);
    const outOfRange =
      read.status === 'ok' &&
      read.sypPerUsd !== null &&
      current !== null &&
      !isFigureInRange(rateFromNumeric(current.sypPerUsd), read.sypPerUsd);
    return {
      status: outOfRange ? 'out_of_range' : read.status,
      sypPerUsd: read.sypPerUsd,
      postedAt: read.postedAt?.toISOString() ?? null,
      excerpt: read.excerpt,
      errorCode: read.errorCode,
    };
  }

  /** A live source locked for update, or 404. */
  private async lockLive(tx: Transaction, id: string): Promise<SourceRow> {
    const [row] = await tx
      .select()
      .from(rateSources)
      .where(and(eq(rateSources.id, id), isNull(rateSources.archivedAt)))
      .for('update');
    if (!row) throw new CodedException(404, 'NOT_FOUND', 'No such rate source');
    return row;
  }

  /** A second live source with the same kind and handle is `RATE_SOURCE_INVALID`. */
  private async write<Row>(work: () => Promise<Row>): Promise<Row> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) throw invalid('Another source reads the same channel or page');
      throw error;
    }
  }

  /** Each source's newest reads, newest first. */
  private async readsOf(db: Database, sourceIds: string[]) {
    const reads = new Map<string, (typeof rateObservations.$inferSelect)[]>();
    if (sourceIds.length === 0) return reads;
    const ranked = db
      .select({
        id: rateObservations.id,
        rank: sql<number>`row_number() over (partition by ${rateObservations.sourceId}
          order by ${rateObservations.fetchedAt} desc, ${rateObservations.id} desc)`.as('rank'),
      })
      .from(rateObservations)
      .where(inArray(rateObservations.sourceId, sourceIds))
      .as('ranked');
    const rows = await db
      .select({ read: rateObservations })
      .from(rateObservations)
      .innerJoin(ranked, eq(ranked.id, rateObservations.id))
      .where(sql`${ranked.rank} <= ${SHOWN_READS}`)
      .orderBy(desc(rateObservations.fetchedAt), desc(rateObservations.id));
    for (const { read } of rows) {
      reads.set(read.sourceId, [...(reads.get(read.sourceId) ?? []), read]);
    }
    return reads;
  }
}
