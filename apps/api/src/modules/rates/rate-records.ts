import {
  type ExchangeRateRecord,
  type RateObservation,
  type RateSource,
  type RateSuggestion,
  type RateSuggestionFigure,
  rateChangePercent,
  rateFromNumeric,
  rateSourceHealth,
} from '@vertex-digital/contracts';
import type {
  ExchangeRateRow,
  RateSuggestionRow,
  rateObservations,
  rateSources,
} from '@vertex-digital/db';

/*
 * The `rates` module's rows as its API shapes (S03, S27). Pure: the services read the rows and
 * the admins' names, these only map them.
 */

type SourceRow = typeof rateSources.$inferSelect;
type ObservationRow = typeof rateObservations.$inferSelect;

/** The ids of the admins a list of rows names, without nulls (automatic rows name none). */
export function adminIdsOf(rows: readonly { adminId: string | null }[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.adminId ? [row.adminId] : [])))];
}

export function toRateRecord(
  row: ExchangeRateRow,
  previous: ExchangeRateRow | null,
  names: Map<string, string>,
): ExchangeRateRecord {
  const sypPerUsd = rateFromNumeric(row.sypPerUsd);
  return {
    id: row.id,
    origin: row.origin,
    sypPerUsd,
    displayStepSypUnits: row.displayStepSypUnits,
    changePercent: previous && rateChangePercent(rateFromNumeric(previous.sypPerUsd), sypPerUsd),
    adminName: (row.adminId && names.get(row.adminId)) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSuggestionRecord(
  row: RateSuggestionRow,
  base: ExchangeRateRow,
  figures: RateSuggestionFigure[],
  names: Map<string, string>,
): RateSuggestion {
  return {
    id: row.id,
    proposedSypPerUsd: rateFromNumeric(row.proposedSypPerUsd),
    baseRateId: row.baseRateId,
    baseSypPerUsd: rateFromNumeric(base.sypPerUsd),
    changePercent: row.changePercent,
    reason: row.reason,
    figures,
    status: row.status,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedChannel: row.decidedChannel,
    adminName: (row.adminId && names.get(row.adminId)) ?? null,
    appliedRateId: row.appliedRateId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toObservation(row: ObservationRow): RateObservation {
  return {
    id: row.id,
    fetchedAt: row.fetchedAt.toISOString(),
    postedAt: row.postedAt?.toISOString() ?? null,
    status: row.status,
    sypPerUsd: row.sypPerUsd === null ? null : rateFromNumeric(row.sypPerUsd),
    excerpt: row.excerpt,
    errorCode: row.errorCode,
  };
}

/** A source with its newest reads (newest first), and its health from them (SR3). */
export function toSourceRecord(row: SourceRow, newestFirst: ObservationRow[]): RateSource {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    handle: row.handle,
    parser: row.parser,
    enabled: row.enabled,
    health: rateSourceHealth(newestFirst),
    observations: newestFirst.map(toObservation),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
