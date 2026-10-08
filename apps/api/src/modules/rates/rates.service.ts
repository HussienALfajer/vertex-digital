import { Inject, Injectable } from '@nestjs/common';
import {
  type ChangeRate,
  type CursorQuery,
  type ExchangeRateRecord,
  isRateStale,
  type RatesOverview,
  rateChangePercent,
  rateConfirmationError,
} from '@vertex-digital/contracts';
import { type Database, exchangeRates, newId, recordAudit } from '@vertex-digital/db';
import { desc, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService } from '../admin/index.js';

/** The rate in force (rule FX9: read with each request that uses it, never cached). */
export interface CurrentRate {
  id: string;
  /** Without trailing zeros: `"118"`, `"118.5"`. */
  sypPerUsd: string;
  displayStepSypUnits: number;
  createdAt: Date;
}

type RateRow = typeof exchangeRates.$inferSelect;

/** `numeric(12,4)` as PostgreSQL writes it (`118.5000`) without the trailing zeros. */
const plainRate = (value: string) => value.replace(/\.?0+$/, '');

/**
 * Serializes rate changes: the 5% check of rule FX2 compares with the rate a parallel change may
 * be replacing. A transaction-level advisory lock, since the app role cannot lock rows of an
 * append-only table (`FOR UPDATE` needs `UPDATE`).
 */
const RATE_CHANGE_LOCK = sql`select pg_advisory_xact_lock(hashtext('exchange_rates'))`;

/**
 * The admin's exchange rate (S03 rules FX1–FX9): the only writer of `exchange_rates`. Other
 * modules read the rate in force through `current()`.
 */
@Injectable()
export class RatesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly admins: AdminAuthService,
  ) {}

  /** The newest rate, or null before the first one (rule FX8). */
  async current(): Promise<CurrentRate | null> {
    const [row] = await this.db
      .select()
      .from(exchangeRates)
      .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
      .limit(1);
    return row ? toCurrent(row) : null;
  }

  /** `GET /api/admin/rates`: the current rate, staleness (rule FX7) and a page of history. */
  async overview(query: CursorQuery): Promise<RatesOverview> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    // One row past the page: it tells whether more follow, and it is the rate before the
    // page's last row, for that row's change percent.
    const rows = await this.db
      .select({ row: exchangeRates, at: cursorTime(exchangeRates.createdAt) })
      .from(exchangeRates)
      .where(cursor ? after(exchangeRates.createdAt, exchangeRates.id, cursor) : undefined)
      .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ row, at }) => ({ at, id: row.id }));
    const names = await this.admins.namesOf([...new Set(page.items.map(({ row }) => row.adminId))]);
    const items = page.items.map(({ row }, index) =>
      toRecord(row, rows[index + 1]?.row ?? null, names),
    );
    const current = cursor ? await this.currentRecord() : (items[0] ?? null);
    return {
      current,
      stale: isRateStale(current ? new Date(current.createdAt) : null, new Date()),
      history: { items, nextCursor: page.nextCursor },
    };
  }

  /** `POST /api/admin/rates` (rules FX1–FX3): a new row and its audit entry. */
  async change(adminId: string, input: ChangeRate, meta: RequestMeta): Promise<ExchangeRateRecord> {
    const record = await this.db.transaction(async (tx) => {
      await tx.execute(RATE_CHANGE_LOCK);
      const [previous] = await tx
        .select()
        .from(exchangeRates)
        .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
        .limit(1);
      const before = previous ? toCurrent(previous) : null;
      const refusal = rateConfirmationError(before?.sypPerUsd ?? null, input);
      if (refusal) {
        throw new CodedException(400, refusal, 'The typed rate confirmation does not hold', {
          changePercent: before && rateChangePercent(before.sypPerUsd, input.sypPerUsd),
        });
      }
      const [row] = await tx
        .insert(exchangeRates)
        .values({
          id: newId(),
          sypPerUsd: input.sypPerUsd,
          displayStepSypUnits: input.displayStepSypUnits,
          adminId,
        })
        .returning();
      if (!row) throw new Error('The rate was not written');
      const after = toCurrent(row);
      const changePercent = before && rateChangePercent(before.sypPerUsd, after.sypPerUsd);
      const values = (rate: CurrentRate) => ({
        sypPerUsd: rate.sypPerUsd,
        displayStepSypUnits: rate.displayStepSypUnits,
      });
      await recordAudit(tx, {
        action: 'exchange_rate.changed',
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'exchange_rate',
        entityId: row.id,
        reason: null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          rateId: row.id,
          before: before && values(before),
          after: values(after),
          changePercent,
        },
      });
      return { row, previous: previous ?? null };
    });
    const names = await this.admins.namesOf([adminId]);
    return toRecord(record.row, record.previous, names);
  }

  private async currentRecord(): Promise<ExchangeRateRecord | null> {
    const rows = await this.db
      .select()
      .from(exchangeRates)
      .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
      .limit(2);
    const [row, previous] = rows;
    if (!row) return null;
    return toRecord(row, previous ?? null, await this.admins.namesOf([row.adminId]));
  }
}

function toCurrent(row: RateRow): CurrentRate {
  return {
    id: row.id,
    sypPerUsd: plainRate(row.sypPerUsd),
    displayStepSypUnits: row.displayStepSypUnits,
    createdAt: row.createdAt,
  };
}

function toRecord(
  row: RateRow,
  previous: RateRow | null,
  names: Map<string, string>,
): ExchangeRateRecord {
  const sypPerUsd = plainRate(row.sypPerUsd);
  return {
    id: row.id,
    sypPerUsd,
    displayStepSypUnits: row.displayStepSypUnits,
    changePercent: previous && rateChangePercent(plainRate(previous.sypPerUsd), sypPerUsd),
    adminName: names.get(row.adminId) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
