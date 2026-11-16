import {
  type AuditActorKind,
  type AuditChannel,
  DEFAULT_RATE_SETTINGS,
  type ErrorCode,
  figureSeenAt,
  type RateDecisionChannel,
  type RateOrigin,
  type RateSettingsValues,
  type RateSuggestionFigure,
  type RateSuggestionReason,
  type RateSuggestionStatus,
  rateChangePercent,
  rateFromNumeric,
  telegramMayApproveRate,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/index.js';
import {
  exchangeRates,
  rateObservations,
  rateSettings,
  rateSources,
  rateSuggestions,
} from '../schema/index.js';
import { queueStoreRevalidate } from '../store/index.js';
import { queueTelegramMessage } from '../telegram/index.js';

/*
 * The exchange rate's write paths (S03, S27, ADR 0017, 0041): every new rate, manual, automatic or
 * approved, and every suggestion's start and end go through here, under one advisory lock.
 */

export type ExchangeRateRow = typeof exchangeRates.$inferSelect;
export type RateSuggestionRow = typeof rateSuggestions.$inferSelect;
export type RateSettingsRow = typeof rateSettings.$inferSelect;

/** A rate refusal the API answers with its contract code. */
export class RateError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RateError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Serializes every rate change, automatic ones included (S27 data): a comparison with the current
 * rate (FX2, AU3, SG2) always reads the rate being replaced. A transaction-level advisory lock,
 * since the app role cannot lock rows of an append-only table; taking it twice is harmless.
 */
export async function lockRates(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('exchange_rates'))`);
}

const NEWEST = [desc(exchangeRates.createdAt), desc(exchangeRates.id)] as const;

/** The rate in force, or null before the first (FX8). */
export async function newestRate(db: Executor): Promise<ExchangeRateRow | null> {
  const [row] = await db
    .select()
    .from(exchangeRates)
    .orderBy(...NEWEST)
    .limit(1);
  return row ?? null;
}

/** AU5: the rate in force at `at`, or the oldest rate when every rate is younger. */
export async function rateInForceAt(db: Executor, at: Date): Promise<ExchangeRateRow | null> {
  const [row] = await db
    .select()
    .from(exchangeRates)
    .where(lte(exchangeRates.createdAt, at))
    .orderBy(...NEWEST)
    .limit(1);
  if (row) return row;
  const [oldest] = await db
    .select()
    .from(exchangeRates)
    .orderBy(asc(exchangeRates.createdAt), asc(exchangeRates.id))
    .limit(1);
  return oldest ?? null;
}

/**
 * AU5's base: the rate in force at `windowStart`, unless the owner set a rate since (by hand or by
 * approving a suggestion): the drift window then counts from the newest such rate (S27 "Manual
 * changes").
 */
export async function driftBaseRate(
  db: Executor,
  windowStart: Date,
): Promise<ExchangeRateRow | null> {
  const [owned] = await db
    .select()
    .from(exchangeRates)
    .where(
      and(
        gt(exchangeRates.createdAt, windowStart),
        inArray(exchangeRates.origin, ['admin', 'suggestion']),
      ),
    )
    .orderBy(...NEWEST)
    .limit(1);
  return owned ?? (await rateInForceAt(db, windowStart));
}

export type RateObservationRow = typeof rateObservations.$inferSelect;

/**
 * SR4: a source's newest `ok` read and when its figure appeared (`figureSeenAt`): the post time,
 * else the oldest read of that figure since the source last gave another one, looked up over all
 * the source's reads (a window of reads would move the time forward and keep a figure fresh).
 */
export async function newestFigure(
  db: Executor,
  sourceId: string,
): Promise<{ read: RateObservationRow; seenAt: Date } | null> {
  const ok = and(eq(rateObservations.sourceId, sourceId), eq(rateObservations.status, 'ok'));
  const [read] = await db
    .select()
    .from(rateObservations)
    .where(ok)
    .orderBy(desc(rateObservations.fetchedAt), desc(rateObservations.id))
    .limit(1);
  if (!read?.sypPerUsd) return null;
  const [{ changedAt } = { changedAt: null }] = await db
    .select({ changedAt: sql<Date | null>`max(${rateObservations.fetchedAt})` })
    .from(rateObservations)
    .where(and(ok, ne(rateObservations.sypPerUsd, read.sypPerUsd)));
  const [{ firstSeen } = { firstSeen: null }] = await db
    .select({ firstSeen: sql<Date | null>`min(${rateObservations.fetchedAt})` })
    .from(rateObservations)
    .where(
      and(
        ok,
        eq(rateObservations.sypPerUsd, read.sypPerUsd),
        changedAt ? gt(rateObservations.fetchedAt, new Date(changedAt)) : undefined,
      ),
    );
  return {
    read,
    seenAt: figureSeenAt(read, firstSeen ? new Date(firstSeen) : read.fetchedAt),
  };
}

/** ST1: the newest settings version and its values; the defaults (updates off) before any. */
export async function rateSettingsInForce(
  db: Executor,
): Promise<{ row: RateSettingsRow | null; values: RateSettingsValues }> {
  const [row] = await db
    .select()
    .from(rateSettings)
    .orderBy(desc(rateSettings.createdAt), desc(rateSettings.id))
    .limit(1);
  if (!row) return { row: null, values: DEFAULT_RATE_SETTINGS };
  const { id: _id, adminId: _admin, createdAt: _at, ...values } = row;
  return { row, values };
}

/** Who writes: the admin (panel or Telegram), or the worker for an automatic rate. */
export interface RateActor {
  actorKind: Extract<AuditActorKind, 'admin' | 'system'>;
  actorId: string | null;
  channel: Extract<AuditChannel, 'admin' | 'telegram' | 'worker'>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface NewRate {
  sypPerUsd: string;
  displayStepSypUnits: number;
  origin: RateOrigin;
  /** Null only for `auto`. */
  adminId: string | null;
  /** The approved suggestion of a `suggestion` row. */
  suggestionId: string | null;
  /** The reads behind an automatic rate, for the audit. */
  observationIds?: string[];
}

/**
 * Writes a new rate under the rate lock (FX1, AU4, SG2) with its audit entry and the store's
 * refresh, and supersedes the pending suggestion unless it is the one being approved (edge case 4). The caller has checked
 * the change against the rate this returns as `previous` (it holds the lock already, or reads it
 * through this call's lock).
 */
export async function writeRate(
  tx: Transaction,
  jobs: JobSender,
  rate: NewRate,
  actor: RateActor,
): Promise<{ row: ExchangeRateRow; previous: ExchangeRateRow | null }> {
  await lockRates(tx);
  const previous = await newestRate(tx);
  const [row] = await tx
    .insert(exchangeRates)
    .values({
      id: newId(),
      sypPerUsd: rate.sypPerUsd,
      displayStepSypUnits: rate.displayStepSypUnits,
      origin: rate.origin,
      adminId: rate.adminId,
      suggestionId: rate.suggestionId,
      // The insert's own time, not the transaction's start (`now()`): a change that began before
      // another but waited for the lock is still the newer rate.
      createdAt: sql`clock_timestamp()`,
    })
    .returning();
  if (!row) throw new Error('The rate was not written');
  // FX4: the store's SYP prices follow the new rate, whoever set it.
  await queueStoreRevalidate(tx, jobs);
  const pending = await pendingSuggestion(tx);
  if (pending && pending.id !== rate.suggestionId) {
    await endSuggestion(tx, jobs, { suggestionId: pending.id, status: 'superseded' });
  }
  const values = (from: ExchangeRateRow) => ({
    sypPerUsd: rateFromNumeric(from.sypPerUsd),
    displayStepSypUnits: from.displayStepSypUnits,
  });
  await recordAudit(tx, {
    action: 'exchange_rate.changed',
    ...actor,
    entityType: 'exchange_rate',
    entityId: row.id,
    reason: null,
    details: {
      rateId: row.id,
      before: previous && values(previous),
      after: values(row),
      changePercent:
        previous && rateChangePercent(rateFromNumeric(previous.sypPerUsd), values(row).sypPerUsd),
      origin: rate.origin,
      suggestionId: rate.suggestionId,
      ...(rate.observationIds && { observationIds: rate.observationIds }),
    },
  });
  return { row, previous };
}

/** The pending suggestion, locked for update, or null. */
export async function pendingSuggestion(tx: Transaction): Promise<RateSuggestionRow | null> {
  const [row] = await tx
    .select()
    .from(rateSuggestions)
    .where(eq(rateSuggestions.status, 'pending'))
    .for('update');
  return row ?? null;
}

export interface SuggestionEnd {
  suggestionId: string;
  status: Exclude<RateSuggestionStatus, 'pending'>;
  channel?: RateDecisionChannel;
  adminId?: string;
  appliedRate?: ExchangeRateRow;
}

/**
 * Ends a pending suggestion once (SG2, SG4, SG5, AU6) and edits its card to the outcome. Null when
 * it was no longer pending: a parallel decision ended it first.
 */
export async function endSuggestion(
  tx: Transaction,
  jobs: JobSender,
  end: SuggestionEnd,
): Promise<RateSuggestionRow | null> {
  const decided = end.status === 'approved' || end.status === 'rejected';
  const [row] = await tx
    .update(rateSuggestions)
    .set({
      status: end.status,
      decidedAt: sql`clock_timestamp()`,
      decidedChannel: decided ? (end.channel ?? null) : null,
      adminId: decided ? (end.adminId ?? null) : null,
      appliedRateId: end.appliedRate?.id ?? null,
    })
    .where(and(eq(rateSuggestions.id, end.suggestionId), eq(rateSuggestions.status, 'pending')))
    .returning();
  if (!row) return null;
  if (row.telegramMessageId) {
    await queueTelegramMessage(tx, jobs, {
      kind: 'rate_suggestion_closed',
      params: {
        suggestionId: row.id,
        cardMessageId: row.telegramMessageId,
        proposedSypPerUsd: rateFromNumeric(row.proposedSypPerUsd),
        status: end.status,
        appliedSypPerUsd: end.appliedRate ? rateFromNumeric(end.appliedRate.sypPerUsd) : null,
      },
      dedupeKey: `rate-suggestion:${row.id}:closed`,
    });
  }
  return row;
}

/** The figures behind a suggestion, with their sources' labels (SG1), highest first. */
export async function suggestionFigures(
  db: Executor,
  observationIds: readonly string[],
): Promise<RateSuggestionFigure[]> {
  if (observationIds.length === 0) return [];
  const rows = await db
    .select({
      sourceLabel: rateSources.label,
      sypPerUsd: rateObservations.sypPerUsd,
      postedAt: rateObservations.postedAt,
      fetchedAt: rateObservations.fetchedAt,
    })
    .from(rateObservations)
    .innerJoin(rateSources, eq(rateSources.id, rateObservations.sourceId))
    .where(inArray(rateObservations.id, [...observationIds]))
    .orderBy(desc(rateObservations.sypPerUsd), asc(rateSources.label));
  return rows.flatMap((row) =>
    row.sypPerUsd === null
      ? []
      : [
          {
            sourceLabel: row.sourceLabel,
            sypPerUsd: rateFromNumeric(row.sypPerUsd),
            at: (row.postedAt ?? row.fetchedAt).toISOString(),
          },
        ],
  );
}

export interface NewSuggestion {
  sypPerUsd: string;
  base: ExchangeRateRow;
  reason: RateSuggestionReason;
  observationIds: string[];
  settings: RateSettingsValues;
  now: Date;
}

/**
 * AU6, SG1: a new pending suggestion, superseding the pending one, with its card queued to the
 * linked chat. The caller holds the rate lock and decided that the value differs enough.
 */
export async function createSuggestion(
  tx: Transaction,
  jobs: JobSender,
  suggestion: NewSuggestion,
): Promise<RateSuggestionRow> {
  await lockRates(tx);
  const pending = await pendingSuggestion(tx);
  if (pending) await endSuggestion(tx, jobs, { suggestionId: pending.id, status: 'superseded' });
  const current = rateFromNumeric(suggestion.base.sypPerUsd);
  const changePercent = rateChangePercent(current, suggestion.sypPerUsd);
  const [row] = await tx
    .insert(rateSuggestions)
    .values({
      id: newId(),
      proposedSypPerUsd: suggestion.sypPerUsd,
      baseRateId: suggestion.base.id,
      changePercent,
      reason: suggestion.reason,
      observationIds: suggestion.observationIds,
    })
    .returning();
  if (!row) throw new Error('The suggestion was not written');
  const { settings, now } = suggestion;
  const driftAt = new Date(now.getTime() - settings.driftWindowHours * 3_600_000);
  const driftBase = (await driftBaseRate(tx, driftAt)) ?? suggestion.base;
  const figures = await suggestionFigures(tx, suggestion.observationIds);
  const messageId = await queueTelegramMessage(tx, jobs, {
    kind: 'rate_suggestion',
    params: {
      suggestionId: row.id,
      currentSypPerUsd: current,
      proposedSypPerUsd: suggestion.sypPerUsd,
      changePercent,
      driftHours: settings.driftWindowHours,
      driftPercent: rateChangePercent(rateFromNumeric(driftBase.sypPerUsd), suggestion.sypPerUsd),
      reason: suggestion.reason,
      figures: figures.slice(0, 10).map((figure) => ({
        sourceLabel: figure.sourceLabel,
        sypPerUsd: figure.sypPerUsd,
        ageMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(figure.at)) / 60_000)),
      })),
      telegramApproves: telegramMayApproveRate(current, suggestion.sypPerUsd, settings),
    },
    dedupeKey: `rate-suggestion:${row.id}`,
  });
  if (!messageId) return row;
  const [carded] = await tx
    .update(rateSuggestions)
    .set({ telegramMessageId: messageId })
    .where(eq(rateSuggestions.id, row.id))
    .returning();
  return carded ?? row;
}
