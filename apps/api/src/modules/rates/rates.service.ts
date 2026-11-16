import { Inject, Injectable } from '@nestjs/common';
import {
  type ChangeRate,
  type CursorQuery,
  type ExchangeRateRecord,
  isRateStale,
  maxDisplayStepSypUnits,
  type RateSuggestion,
  type RatesOverview,
  rateChangePercent,
  rateConfirmationError,
  rateFromNumeric,
} from '@vertex-digital/contracts';
import {
  cheapestAvailablePrice,
  type Database,
  type ExchangeRateRow,
  type Executor,
  exchangeRates,
  lockRates,
  newestRate,
  rateSettingsInForce,
  rateSuggestions,
  readAll,
  suggestionFigures,
  type Transaction,
  writeRate,
} from '@vertex-digital/db';
import { desc, eq } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService } from '../admin/index.js';
import { adminIdsOf, toRateRecord, toSuggestionRecord } from './rate-records.js';

/** The rate in force (rule FX9: read with each request that uses it, never cached). */
export interface CurrentRate {
  id: string;
  /** Without trailing zeros: `"118"`, `"118.5"`. */
  sypPerUsd: string;
  displayStepSypUnits: number;
  createdAt: Date;
}

/**
 * The exchange rate (S03 rules FX1–FX9, S27): the admin's changes and the panel's overview. Every
 * rate, manual, automatic or approved, is written by `writeRate` in `packages/db` under one lock;
 * other modules read the rate in force through `current()`.
 */
@Injectable()
export class RatesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly admins: AdminAuthService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * The newest rate, or null before the first one (rule FX8). A caller inside a transaction
   * passes it: a read through the pool while the transaction holds a connection and a row lock
   * can leave every connection waiting on the others (F3-4).
   */
  async current(db: Database | Transaction = this.db): Promise<CurrentRate | null> {
    const row = await newestRate(db);
    return row ? toCurrent(row) : null;
  }

  /**
   * `GET /api/admin/rates`: the current rate, staleness (rule FX7), the pending suggestion, whether
   * automatic updates are on (S27), and a page of history.
   */
  async overview(query: CursorQuery): Promise<RatesOverview> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    // One row past the page: it tells whether more follow, and it is the rate before the
    // page's last row, for that row's change percent.
    const [rows, settings, pending] = await readAll(this.db, [
      () =>
        this.db
          .select({ row: exchangeRates, at: cursorTime(exchangeRates.createdAt) })
          .from(exchangeRates)
          .where(cursor ? after(exchangeRates.createdAt, exchangeRates.id, cursor) : undefined)
          .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
          .limit(query.limit + 1),
      () => rateSettingsInForce(this.db),
      () => this.pendingSuggestion(this.db),
    ]);
    const page = pageOf(rows, query.limit, ({ row, at }) => ({ at, id: row.id }));
    const names = await this.admins.namesOf(adminIdsOf(page.items.map(({ row }) => row)));
    const items = page.items.map(({ row }, index) =>
      toRateRecord(row, rows[index + 1]?.row ?? null, names),
    );
    const current = cursor ? await this.currentRecord() : (items[0] ?? null);
    return {
      current,
      stale: isRateStale(current ? new Date(current.createdAt) : null, new Date()),
      pendingSuggestion: pending,
      autoEnabled: settings.values.autoEnabled,
      history: { items, nextCursor: page.nextCursor },
    };
  }

  /** `POST /api/admin/rates` (rules FX1–FX3): a new row and its audit entry. */
  async change(adminId: string, input: ChangeRate, meta: RequestMeta): Promise<ExchangeRateRecord> {
    const written = await this.db.transaction(async (tx) => {
      await lockRates(tx);
      const before = await newestRate(tx);
      const refusal = rateConfirmationError(
        before ? rateFromNumeric(before.sypPerUsd) : null,
        input,
      );
      if (refusal) {
        throw new CodedException(400, refusal, 'The typed rate confirmation does not hold', {
          changePercent:
            before && rateChangePercent(rateFromNumeric(before.sypPerUsd), input.sypPerUsd),
        });
      }
      await this.checkDisplayStep(tx, input.sypPerUsd, input.displayStepSypUnits);
      return writeRate(
        tx,
        this.jobs,
        { ...input, origin: 'admin', adminId, suggestionId: null },
        { actorKind: 'admin', actorId: adminId, channel: 'admin', ...meta },
      );
    });
    const names = await this.admins.namesOf([adminId]);
    return toRateRecord(written.row, written.previous, names);
  }

  /**
   * S07 rule P9: the display step may add at most 2% to the cheapest available product at `rate`.
   * Checked for every rate the admin sets or approves; an automatic rate keeps the step in force.
   */
  async checkDisplayStep(tx: Transaction, rate: string, stepSypUnits: number): Promise<void> {
    const cheapest = await cheapestAvailablePrice(tx, routingContext(this.env));
    const maxStep = cheapest === null ? null : maxDisplayStepSypUnits(rate, cheapest);
    if (maxStep !== null && stepSypUnits > maxStep) {
      throw new CodedException(
        400,
        'DISPLAY_STEP_TOO_LARGE',
        'The display step adds more than 2% to the cheapest available product',
        { maxStepSypUnits: maxStep },
      );
    }
  }

  /** The pending suggestion with its figures, or null (S27 `/rates`). */
  async pendingSuggestion(db: Executor): Promise<RateSuggestion | null> {
    const [found] = await db
      .select({ suggestion: rateSuggestions, base: exchangeRates })
      .from(rateSuggestions)
      .innerJoin(exchangeRates, eq(exchangeRates.id, rateSuggestions.baseRateId))
      .where(eq(rateSuggestions.status, 'pending'));
    if (!found) return null;
    const figures = await suggestionFigures(db, found.suggestion.observationIds);
    return toSuggestionRecord(found.suggestion, found.base, figures, new Map());
  }

  private async currentRecord(): Promise<ExchangeRateRecord | null> {
    const rows = await this.db
      .select()
      .from(exchangeRates)
      .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
      .limit(2);
    const [row, previous] = rows;
    if (!row) return null;
    return toRateRecord(row, previous ?? null, await this.admins.namesOf(adminIdsOf([row])));
  }
}

function toCurrent(row: ExchangeRateRow): CurrentRate {
  return {
    id: row.id,
    sypPerUsd: rateFromNumeric(row.sypPerUsd),
    displayStepSypUnits: row.displayStepSypUnits,
    createdAt: row.createdAt,
  };
}
