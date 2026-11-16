import { Inject, Injectable } from '@nestjs/common';
import {
  type ApproveRateSuggestion,
  type ExchangeRateRecord,
  type RateDecisionChannel,
  type RateSuggestion,
  type RateSuggestionListQuery,
  type RateSuggestionPage,
  rateChangePercent,
  rateConfirmationError,
  rateFromNumeric,
  telegramMayApproveRate,
} from '@vertex-digital/contracts';
import {
  type Database,
  type ExchangeRateRow,
  endSuggestion,
  exchangeRates,
  lockRates,
  newestRate,
  type RateSuggestionRow,
  rateSettingsInForce,
  rateSuggestions,
  recordAudit,
  suggestionFigures,
  type Transaction,
  writeRate,
} from '@vertex-digital/db';
import { and, desc, eq } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService } from '../admin/index.js';
import { adminIdsOf, toRateRecord, toSuggestionRecord } from './rate-records.js';
import { RatesService } from './rates.service.js';

const notPending = () =>
  new CodedException(409, 'RATE_SUGGESTION_STATE_CONFLICT', 'The suggestion is no longer pending');

interface Approval {
  adminId: string;
  channel: RateDecisionChannel;
  /** The admin's edit of the proposed value (panel only, SG3). */
  sypPerUsd?: string;
  rateConfirmation?: string;
  meta: RequestMeta;
}

/**
 * S27 SG1–SG5: suggestions the automatic path did not apply alone. The panel approves (the proposed
 * value or an edit, re-authenticated, FX2's typed confirmation above 5%) or rejects; Telegram
 * approves only the proposed value within its cap, checked against the rate at that moment.
 */
@Injectable()
export class RateSuggestionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly admins: AdminAuthService,
    private readonly jobs: JobsService,
    private readonly rates: RatesService,
  ) {}

  /** `GET /api/admin/rate-suggestions`: newest first, by status. */
  async list(query: RateSuggestionListQuery): Promise<RateSuggestionPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({
        suggestion: rateSuggestions,
        base: exchangeRates,
        at: cursorTime(rateSuggestions.createdAt),
      })
      .from(rateSuggestions)
      .innerJoin(exchangeRates, eq(exchangeRates.id, rateSuggestions.baseRateId))
      .where(
        and(
          query.status ? eq(rateSuggestions.status, query.status) : undefined,
          cursor ? after(rateSuggestions.createdAt, rateSuggestions.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(rateSuggestions.createdAt), desc(rateSuggestions.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ suggestion, at }) => ({ at, id: suggestion.id }));
    const names = await this.admins.namesOf(adminIdsOf(page.items.map((row) => row.suggestion)));
    const items: RateSuggestion[] = [];
    for (const { suggestion, base } of page.items) {
      const figures = await suggestionFigures(this.db, suggestion.observationIds);
      items.push(toSuggestionRecord(suggestion, base, figures, names));
    }
    return { items, nextCursor: page.nextCursor };
  }

  /** `POST /api/admin/rate-suggestions/:id/approve` (SG2, SG3). */
  async approve(
    adminId: string,
    id: string,
    input: ApproveRateSuggestion,
    meta: RequestMeta,
  ): Promise<ExchangeRateRecord> {
    const written = await this.db.transaction((tx) =>
      this.approveIn(tx, id, { adminId, channel: 'panel', ...input, meta }),
    );
    return toRateRecord(written.row, written.previous, await this.admins.namesOf([adminId]));
  }

  /** `POST /api/admin/rate-suggestions/:id/reject` (SG4). */
  async reject(adminId: string, id: string, meta: RequestMeta): Promise<RateSuggestion> {
    const row = await this.db.transaction((tx) =>
      this.rejectIn(tx, id, { adminId, channel: 'panel', meta }),
    );
    const [base] = await this.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.id, row.baseRateId));
    if (!base) throw new Error(`Suggestion ${row.id} names no base rate`);
    const figures = await suggestionFigures(this.db, row.observationIds);
    return toSuggestionRecord(row, base, figures, await this.admins.namesOf([adminId]));
  }

  /**
   * The approval, in the caller's transaction (the panel's, or the Telegram update's savepoint).
   * Under the rate lock: the change is measured against the rate being replaced.
   */
  async approveIn(
    tx: Transaction,
    id: string,
    approval: Approval,
  ): Promise<{ row: ExchangeRateRow; previous: ExchangeRateRow | null }> {
    await lockRates(tx);
    const suggestion = await this.lockPending(tx, id);
    const current = await newestRate(tx);
    if (!current) throw notPending();
    const currentRate = rateFromNumeric(current.sypPerUsd);
    const proposed = rateFromNumeric(suggestion.proposedSypPerUsd);
    const value = approval.sypPerUsd ?? proposed;
    if (approval.channel === 'telegram') {
      const { values } = await rateSettingsInForce(tx);
      if (!telegramMayApproveRate(currentRate, proposed, values)) {
        throw new CodedException(
          400,
          'RATE_SUGGESTION_TOO_LARGE_FOR_TELEGRAM',
          'The move is above the Telegram cap against the rate in force',
          { changePercent: rateChangePercent(currentRate, proposed) },
        );
      }
    } else {
      const refusal = rateConfirmationError(currentRate, {
        sypPerUsd: value,
        rateConfirmation: approval.rateConfirmation,
      });
      if (refusal) {
        throw new CodedException(400, refusal, 'The typed rate confirmation does not hold', {
          changePercent: rateChangePercent(currentRate, value),
        });
      }
    }
    await this.rates.checkDisplayStep(tx, value, current.displayStepSypUnits);
    const actor = {
      actorKind: 'admin',
      actorId: approval.adminId,
      channel: approval.channel === 'panel' ? 'admin' : 'telegram',
      ...approval.meta,
    } as const;
    const written = await writeRate(
      tx,
      this.jobs,
      {
        sypPerUsd: value,
        displayStepSypUnits: current.displayStepSypUnits,
        origin: 'suggestion',
        adminId: approval.adminId,
        suggestionId: suggestion.id,
      },
      actor,
    );
    const ended = await endSuggestion(tx, this.jobs, {
      suggestionId: suggestion.id,
      status: 'approved',
      channel: approval.channel,
      adminId: approval.adminId,
      appliedRate: written.row,
    });
    if (!ended) throw notPending();
    await recordAudit(tx, {
      action: 'rate_suggestion.approved',
      ...actor,
      entityType: 'rate_suggestion',
      entityId: suggestion.id,
      details: {
        suggestionId: suggestion.id,
        proposedSypPerUsd: proposed,
        approvedSypPerUsd: value,
        rateId: written.row.id,
        channel: approval.channel,
      },
    });
    return written;
  }

  /** The rejection, in the caller's transaction; needs no reason (SG4). */
  async rejectIn(
    tx: Transaction,
    id: string,
    rejection: Pick<Approval, 'adminId' | 'channel' | 'meta'>,
  ): Promise<RateSuggestionRow> {
    await lockRates(tx);
    const suggestion = await this.lockPending(tx, id);
    const ended = await endSuggestion(tx, this.jobs, {
      suggestionId: suggestion.id,
      status: 'rejected',
      channel: rejection.channel,
      adminId: rejection.adminId,
    });
    if (!ended) throw notPending();
    await recordAudit(tx, {
      action: 'rate_suggestion.rejected',
      actorKind: 'admin',
      actorId: rejection.adminId,
      channel: rejection.channel === 'panel' ? 'admin' : 'telegram',
      entityType: 'rate_suggestion',
      entityId: suggestion.id,
      details: {
        suggestionId: suggestion.id,
        proposedSypPerUsd: rateFromNumeric(suggestion.proposedSypPerUsd),
        channel: rejection.channel,
      },
      ...rejection.meta,
    });
    return ended;
  }

  /** The suggestion locked for update: 404 when missing, a conflict when no longer pending. */
  private async lockPending(tx: Transaction, id: string): Promise<RateSuggestionRow> {
    const [row] = await tx
      .select()
      .from(rateSuggestions)
      .where(eq(rateSuggestions.id, id))
      .for('update');
    if (!row) throw new CodedException(404, 'NOT_FOUND', 'No such rate suggestion');
    if (row.status !== 'pending') throw notPending();
    return row;
  }
}
