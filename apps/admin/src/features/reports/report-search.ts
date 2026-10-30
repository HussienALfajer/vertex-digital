import {
  REPORT_BREAKDOWNS,
  REPORT_KINDS,
  type ReportBreakdown,
  type ReportKind,
  reportPeriodError,
} from '@vertex-digital/contracts';

/*
 * The reports page's report, period and breakdown as the URL holds them (S13 rule RP1), so a
 * report can be reloaded and shared. Dates are `Asia/Damascus` calendar days, both ends included.
 */

export const REPORT_PRESETS = ['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth'] as const;

export type ReportPreset = (typeof REPORT_PRESETS)[number];

export interface ReportSearch {
  /** Absent for R1, so a plain link to `/reports` opens it. */
  kind?: Exclude<ReportKind, 'sales'>;
  /** Absent for the default period, the last 7 days. */
  from?: string;
  to?: string;
  /** R2 only; absent for `game`. */
  by?: Exclude<ReportBreakdown, 'game'>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const damascusDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today in Damascus, `YYYY-MM-DD`. */
export const damascusToday = (now: Date) => damascusDay.format(now);

/** `date` moved by whole days, on the calendar (no time zone involved). */
function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** Rule RP1's presets, in Damascus days. */
export function presetPeriod(preset: ReportPreset, now: Date): { from: string; to: string } {
  const today = damascusToday(now);
  const monthStart = `${today.slice(0, 8)}01`;
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'thisMonth':
      return { from: monthStart, to: today };
    case 'lastMonth': {
      const lastMonthEnd = addDays(monthStart, -1);
      return { from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd };
    }
  }
}

/** The preset a period matches, or null for a custom period. */
export function presetOf(period: { from: string; to: string }, now: Date): ReportPreset | null {
  return (
    REPORT_PRESETS.find((preset) => {
      const candidate = presetPeriod(preset, now);
      return candidate.from === period.from && candidate.to === period.to;
    }) ?? null
  );
}

export const kindOf = (search: ReportSearch): ReportKind => search.kind ?? 'sales';

export const breakdownOf = (search: ReportSearch): ReportBreakdown => search.by ?? 'game';

/** The period a search shows: its own when valid, else the last 7 days. */
export function periodOf(search: ReportSearch, now: Date): { from: string; to: string } {
  return search.from && search.to
    ? { from: search.from, to: search.to }
    : presetPeriod('last7', now);
}

/** Keeps only what is valid (a period within rule RP1); anything else in the URL is dropped. */
export function parseReportSearch(search: Record<string, unknown>): ReportSearch {
  const parsed: ReportSearch = {};
  if (search.kind !== 'sales' && (REPORT_KINDS as readonly unknown[]).includes(search.kind)) {
    parsed.kind = search.kind as ReportSearch['kind'];
  }
  const { from, to } = search;
  if (
    typeof from === 'string' &&
    typeof to === 'string' &&
    DATE.test(from) &&
    DATE.test(to) &&
    reportPeriodError(from, to) === null
  ) {
    parsed.from = from;
    parsed.to = to;
  }
  if (
    parsed.kind === 'breakdown' &&
    search.by !== 'game' &&
    (REPORT_BREAKDOWNS as readonly unknown[]).includes(search.by)
  ) {
    parsed.by = search.by as ReportSearch['by'];
  }
  return parsed;
}

/** The search for a report; the period stays, the breakdown only on R2. */
export function withKind(search: ReportSearch, kind: ReportKind): ReportSearch {
  const { kind: _kind, by, ...rest } = search;
  if (kind === 'sales') return rest;
  return kind === 'breakdown' && by ? { ...rest, kind, by } : { ...rest, kind };
}

/** S23 AD4: the report by tier's month, `YYYY-MM`; absent for the current Damascus month. */
export interface TierReportSearch {
  month?: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseTierReportSearch(search: Record<string, unknown>): TierReportSearch {
  return typeof search.month === 'string' && MONTH.test(search.month) ? { month: search.month } : {};
}

/** The month the report shows: the URL's, else this Damascus month. */
export const tierReportMonth = (search: TierReportSearch, now: Date) =>
  search.month ?? damascusToday(now).slice(0, 7);
