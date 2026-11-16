import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import {
  basisPointsBetween,
  CURRENCY_SCALE,
  compareRates,
  exchangeRateSchema,
  isSameRate,
  rateChangePercent,
  usdToSyp,
} from './money.js';

/*
 * The admin's USD→SYP exchange rate (S03, F04; ADR 0003, 0017), owned by the api `rates`
 * module. One rate for display and SYP deposits (rule FX1); every change is a new row.
 */

/** A change above this percent of the current rate needs the rate typed twice (rule FX2). */
export const RATE_CONFIRMATION_THRESHOLD_PERCENT = 5;

/** The panel's banner shows while the newest rate is older than this (rule FX7). */
export const RATE_STALE_AFTER_HOURS = 48;

/** A SYP deposit's quote locks the rate for this long (rule FX5, A12). */
export const QUOTE_LOCK_MINUTES = 15;

/** The display step's bounds in SYP units: 1 to 50 pounds (rule FX3). */
export const DISPLAY_STEP_MIN_SYP_UNITS = 1 * CURRENCY_SCALE.SYP;
export const DISPLAY_STEP_MAX_SYP_UNITS = 50 * CURRENCY_SCALE.SYP;

/** The step SYP displays round to (rule FX3): whole pounds, 1 to 50. */
export const displayStepSchema = z
  .int()
  .min(DISPLAY_STEP_MIN_SYP_UNITS)
  .max(DISPLAY_STEP_MAX_SYP_UNITS)
  .refine((units) => units % CURRENCY_SCALE.SYP === 0, 'Expected whole pounds');

/**
 * Who set a rate (S27, ADR 0041): the admin by hand, the automatic path, or the admin approving a
 * source-made suggestion. Rows before S27 are `admin`.
 */
export const RATE_ORIGINS = ['admin', 'auto', 'suggestion'] as const;

export const rateOriginSchema = z.enum(RATE_ORIGINS).meta({ id: 'RateOrigin' });

export type RateOrigin = z.infer<typeof rateOriginSchema>;

/** One saved rate, as the panel's history shows it. */
export const exchangeRateRecordSchema = z
  .object({
    id: z.uuid(),
    origin: rateOriginSchema,
    sypPerUsd: exchangeRateSchema,
    displayStepSypUnits: displayStepSchema,
    /** Against the rate before it (`rateChangePercent`); null for the first rate. */
    changePercent: z.string().nullable(),
    /** The admin who saved or approved it; null for an automatic rate or a replaced admin. */
    adminName: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ExchangeRateRecord' });

export type ExchangeRateRecord = z.infer<typeof exchangeRateRecordSchema>;

/** `POST /api/admin/rates` (rules FX1–FX3). */
export const changeRateSchema = z
  .object({
    sypPerUsd: exchangeRateSchema,
    displayStepSypUnits: displayStepSchema,
    /** The rate typed a second time; required for a change above 5% (rule FX2). */
    rateConfirmation: z.string().trim().max(20).optional(),
  })
  .meta({ id: 'ChangeRate' });

export type ChangeRate = z.infer<typeof changeRateSchema>;

/**
 * The refusal of a rate change's typed confirmation (rule FX2), or null: the first rate and a
 * change of at most 5% need none; above 5% it is required and must equal the new rate.
 */
export function rateConfirmationError(
  currentRate: string | null,
  input: Pick<ChangeRate, 'sypPerUsd' | 'rateConfirmation'>,
): 'RATE_CONFIRMATION_REQUIRED' | 'RATE_CONFIRMATION_MISMATCH' | null {
  if (currentRate === null) return null;
  const percent = Math.abs(Number(rateChangePercent(currentRate, input.sypPerUsd)));
  if (percent <= RATE_CONFIRMATION_THRESHOLD_PERCENT) return null;
  if (input.rateConfirmation === undefined) return 'RATE_CONFIRMATION_REQUIRED';
  return isSameRate(input.rateConfirmation, input.sypPerUsd) ? null : 'RATE_CONFIRMATION_MISMATCH';
}

export const ratePageSchema = cursorPageSchema(exchangeRateRecordSchema, 'RatePage');

export type RatePage = z.infer<typeof ratePageSchema>;

/** True when the newest rate is older than 48 hours at `now`, or there is none (rule FX7). */
export function isRateStale(createdAt: Date | null, now: Date): boolean {
  if (createdAt === null) return true;
  return now.getTime() - createdAt.getTime() > RATE_STALE_AFTER_HOURS * 60 * 60 * 1000;
}

/** The display step may add at most this share of the cheapest price, in percent (ADR 0003). */
export const DISPLAY_STEP_MAX_PERCENT = 2;

/**
 * The largest display step, in whole pounds, that adds at most 2% to the SYP value of the
 * cheapest available product (S07 rule P9, S03 rule FX3): `usdToSyp(price, rate, 'down')` × 2%,
 * rounded down to whole pounds, and never below FX3's minimum of 1 pound: a product under about
 * $0.42 at 118 pounds would otherwise refuse every step, and with it every rate change.
 */
export function maxDisplayStepSypUnits(rate: string, cheapestPriceUsdUnits: number): number {
  const percentOfSyp = usdToSyp(cheapestPriceUsdUnits, rate, 'down') * DISPLAY_STEP_MAX_PERCENT;
  const wholePoundsTimes100 = percentOfSyp - (percentOfSyp % (100 * CURRENCY_SCALE.SYP));
  return Math.max(wholePoundsTimes100 / 100, DISPLAY_STEP_MIN_SYP_UNITS);
}

/*
 * S27 (F46, ADR 0041): automatic updates from public sources. Sources are read every few minutes;
 * small moves two sources agree on are applied alone, every other move is a suggestion the admin
 * approves or rejects.
 */

/** Where a source is read: a public Telegram channel's web preview, or a "الليرة اليوم" page. */
export const RATE_SOURCE_KINDS = ['telegram_channel', 'sp_today_page'] as const;

export const rateSourceKindSchema = z.enum(RATE_SOURCE_KINDS).meta({ id: 'RateSourceKind' });

export type RateSourceKind = z.infer<typeof rateSourceKindSchema>;

/** The pounds a source posts in: new pounds, or old pounds divided by 100 (ADR 0003). */
export const RATE_SOURCE_UNITS = ['new_syp', 'old_syp'] as const;

export const rateSourceUnitSchema = z.enum(RATE_SOURCE_UNITS).meta({ id: 'RateSourceUnit' });

/** A Telegram channel's username, and a sp-today page path (the host is fixed in code). */
const TELEGRAM_HANDLE = /^[A-Za-z0-9_]{5,32}$/;
const SP_TODAY_PATH = /^\/[a-z0-9/_-]{1,120}$/;

/** True when `handle` names a source of `kind` (S27 data: strict patterns, never a host). */
export function isRateSourceHandle(kind: RateSourceKind, handle: string): boolean {
  return kind === 'telegram_channel'
    ? TELEGRAM_HANDLE.test(handle)
    : SP_TODAY_PATH.test(handle) && !handle.includes('//');
}

/** The keyword a new source starts with (decision 3: the dollar's sell price). */
export const DEFAULT_SELL_WORD = 'مبيع';

/** How a source's text is read (SR2, SR5): plain keywords, never patterns. */
export const rateSourceParserSchema = z
  .object({
    cityWord: z.string().trim().min(1).max(40).nullable(),
    sellWord: z.string().trim().min(1).max(20).default(DEFAULT_SELL_WORD),
    unit: rateSourceUnitSchema,
  })
  .meta({ id: 'RateSourceParser' });

export type RateSourceParser = z.infer<typeof rateSourceParserSchema>;

const sourceTarget = z.object({
  kind: rateSourceKindSchema,
  handle: z.string().trim().min(1).max(121),
  parser: rateSourceParserSchema,
});

/** The handle as stored (`normaliseRateSourceHandle`), after the check below. */
function normaliseHandle<Source extends { kind: RateSourceKind; handle: string }>(
  source: Source,
): Source {
  return { ...source, handle: normaliseRateSourceHandle(source.kind, source.handle) };
}

function checkHandle(source: { kind: RateSourceKind; handle: string }, context: z.RefinementCtx) {
  if (!isRateSourceHandle(source.kind, normaliseRateSourceHandle(source.kind, source.handle))) {
    context.addIssue({ code: 'custom', path: ['handle'], message: 'Invalid source handle' });
  }
}

/** `POST /api/admin/rate-sources`. */
export const createRateSourceSchema = sourceTarget
  .extend({ label: z.string().trim().min(2).max(40), enabled: z.boolean().default(true) })
  .superRefine(checkHandle)
  .transform(normaliseHandle)
  .meta({ id: 'CreateRateSource' });

export type CreateRateSource = z.infer<typeof createRateSourceSchema>;

/** `PATCH /api/admin/rate-sources/:id`: the kind stays; the service checks the handle against it. */
export const updateRateSourceSchema = z
  .object({
    label: z.string().trim().min(2).max(40),
    handle: z.string().trim().min(1).max(121),
    parser: rateSourceParserSchema,
    enabled: z.boolean(),
  })
  .partial()
  .meta({ id: 'UpdateRateSource' });

export type UpdateRateSource = z.infer<typeof updateRateSourceSchema>;

/** `POST /api/admin/rate-sources/test`: a read that stores nothing. */
export const testRateSourceSchema = sourceTarget
  .superRefine(checkHandle)
  .transform(normaliseHandle)
  .meta({ id: 'TestRateSource' });

export type TestRateSource = z.infer<typeof testRateSourceSchema>;

/** One read of one source (`rate_observations.status`). */
export const RATE_OBSERVATION_STATUSES = [
  'ok',
  'no_match',
  'fetch_failed',
  'out_of_range',
] as const;

export const rateObservationStatusSchema = z
  .enum(RATE_OBSERVATION_STATUSES)
  .meta({ id: 'RateObservationStatus' });

export type RateObservationStatus = z.infer<typeof rateObservationStatusSchema>;

export const rateObservationSchema = z
  .object({
    id: z.uuid(),
    fetchedAt: z.iso.datetime(),
    postedAt: z.iso.datetime().nullable(),
    status: rateObservationStatusSchema,
    sypPerUsd: exchangeRateSchema.nullable(),
    excerpt: z.string().nullable(),
    errorCode: z.string().nullable(),
  })
  .meta({ id: 'RateObservation' });

export type RateObservation = z.infer<typeof rateObservationSchema>;

/** `POST /api/admin/rate-sources/test`'s answer. */
export const rateSourceTestResultSchema = rateObservationSchema
  .pick({ status: true, sypPerUsd: true, postedAt: true, excerpt: true, errorCode: true })
  .meta({ id: 'RateSourceTestResult' });

export type RateSourceTestResult = z.infer<typeof rateSourceTestResultSchema>;

/** A source's health as the panel shows it (SR3); `unknown` before its first read. */
export const RATE_SOURCE_HEALTHS = ['ok', 'broken', 'unknown'] as const;

export type RateSourceHealth = (typeof RATE_SOURCE_HEALTHS)[number];

/** SR3: three failed reads in a row make a source broken. */
export const RATE_SOURCE_BROKEN_AFTER = 3;

/** SR3: a source is broken when its newest read is out of range or its last three failed. */
export function rateSourceHealth(
  newestFirst: readonly { status: RateObservationStatus }[],
): RateSourceHealth {
  const [newest] = newestFirst;
  if (!newest) return 'unknown';
  if (newest.status === 'ok') return 'ok';
  if (newest.status === 'out_of_range') return 'broken';
  const failed = newestFirst
    .slice(0, RATE_SOURCE_BROKEN_AFTER)
    .filter((read) => read.status === 'no_match' || read.status === 'fetch_failed');
  return failed.length === RATE_SOURCE_BROKEN_AFTER ? 'broken' : 'unknown';
}

/** A source with its health and last three reads, newest first (the panel's "المصادر"). */
export const rateSourceSchema = z
  .object({
    id: z.uuid(),
    kind: rateSourceKindSchema,
    label: z.string(),
    handle: z.string(),
    parser: rateSourceParserSchema,
    enabled: z.boolean(),
    health: z.enum(RATE_SOURCE_HEALTHS),
    observations: z.array(rateObservationSchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RateSource' });

export type RateSource = z.infer<typeof rateSourceSchema>;

export const rateSourceListSchema = z
  .object({ items: z.array(rateSourceSchema) })
  .meta({ id: 'RateSourceList' });

export type RateSourceList = z.infer<typeof rateSourceListSchema>;

/** Why a move became a suggestion and was not applied alone (AU6). */
export const RATE_SUGGESTION_REASONS = [
  'single_source',
  'sources_disagree',
  'move_too_large',
  'drift_too_large',
  'auto_off',
] as const;

export const rateSuggestionReasonSchema = z
  .enum(RATE_SUGGESTION_REASONS)
  .meta({ id: 'RateSuggestionReason' });

export type RateSuggestionReason = z.infer<typeof rateSuggestionReasonSchema>;

export const RATE_SUGGESTION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
  'expired',
] as const;

export const rateSuggestionStatusSchema = z
  .enum(RATE_SUGGESTION_STATUSES)
  .meta({ id: 'RateSuggestionStatus' });

export type RateSuggestionStatus = z.infer<typeof rateSuggestionStatusSchema>;

/** Where a suggestion was decided. */
export const RATE_DECISION_CHANNELS = ['panel', 'telegram'] as const;

export const rateDecisionChannelSchema = z
  .enum(RATE_DECISION_CHANNELS)
  .meta({ id: 'RateDecisionChannel' });

export type RateDecisionChannel = z.infer<typeof rateDecisionChannelSchema>;

/** A pending suggestion expires after 6 hours (SG5); a rejection is remembered as long (SG4). */
export const RATE_SUGGESTION_TTL_HOURS = 6;

/** One figure behind a suggestion, with its source's label (SG1). */
export const rateSuggestionFigureSchema = z
  .object({
    sourceLabel: z.string(),
    sypPerUsd: exchangeRateSchema,
    /** The post's time, else when the figure was read. */
    at: z.iso.datetime(),
  })
  .meta({ id: 'RateSuggestionFigure' });

export type RateSuggestionFigure = z.infer<typeof rateSuggestionFigureSchema>;

export const rateSuggestionSchema = z
  .object({
    id: z.uuid(),
    proposedSypPerUsd: exchangeRateSchema,
    baseRateId: z.uuid(),
    baseSypPerUsd: exchangeRateSchema,
    /** Signed percent against the base rate (`rateChangePercent`). */
    changePercent: z.string(),
    reason: rateSuggestionReasonSchema,
    figures: z.array(rateSuggestionFigureSchema),
    status: rateSuggestionStatusSchema,
    decidedAt: z.iso.datetime().nullable(),
    decidedChannel: rateDecisionChannelSchema.nullable(),
    adminName: z.string().nullable(),
    appliedRateId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'RateSuggestion' });

export type RateSuggestion = z.infer<typeof rateSuggestionSchema>;

export const rateSuggestionPageSchema = cursorPageSchema(
  rateSuggestionSchema,
  'RateSuggestionPage',
);

export type RateSuggestionPage = z.infer<typeof rateSuggestionPageSchema>;

/** `GET /api/admin/rate-suggestions`. */
export const rateSuggestionListQuerySchema = cursorQuerySchema
  .extend({ status: rateSuggestionStatusSchema.optional() })
  .meta({ id: 'RateSuggestionListQuery' });

export type RateSuggestionListQuery = z.infer<typeof rateSuggestionListQuerySchema>;

/** `POST /api/admin/rate-suggestions/:id/approve` (SG3): the proposed value, or an edited one. */
export const approveRateSuggestionSchema = z
  .object({
    sypPerUsd: exchangeRateSchema.optional(),
    rateConfirmation: changeRateSchema.shape.rateConfirmation,
  })
  .meta({ id: 'ApproveRateSuggestion' });

export type ApproveRateSuggestion = z.infer<typeof approveRateSuggestionSchema>;

/** ADR 0041: Telegram never approves a move above 5%, whatever the settings say. */
export const TELEGRAM_RATE_APPROVE_CEILING_BPS = 500;

/** ST2: each threshold's bounds. */
export const rateSettingsValuesSchema = z
  .object({
    autoEnabled: z.boolean(),
    autoMaxMoveBps: z.int().min(50).max(300),
    agreementMaxSpreadBps: z.int().min(25).max(300),
    minAgreeingSources: z.int().min(2).max(5),
    driftWindowHours: z.int().min(6).max(72),
    driftMaxBps: z.int().min(100).max(500),
    minMoveBps: z.int().min(10).max(100),
    freshnessMinutes: z.int().min(30).max(720),
    silentAlertHours: z.int().min(1).max(48),
    telegramApproveMaxBps: z.int().min(100).max(TELEGRAM_RATE_APPROVE_CEILING_BPS),
    pollMinutes: z.int().min(10).max(60),
  })
  .meta({ id: 'RateSettingsValues' });

export type RateSettingsValues = z.infer<typeof rateSettingsValuesSchema>;

/** The values in force before the first saved version: automatic updates off (ST1). */
export const DEFAULT_RATE_SETTINGS: RateSettingsValues = {
  autoEnabled: false,
  autoMaxMoveBps: 200,
  agreementMaxSpreadBps: 100,
  minAgreeingSources: 2,
  driftWindowHours: 24,
  driftMaxBps: 200,
  minMoveBps: 25,
  freshnessMinutes: 180,
  silentAlertHours: 6,
  telegramApproveMaxBps: 500,
  pollMinutes: 15,
};

/** `GET /api/admin/rate-settings`: the version in force; `id` is null before the first save. */
export const rateSettingsSchema = rateSettingsValuesSchema
  .extend({
    id: z.uuid().nullable(),
    adminName: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'RateSettings' });

export type RateSettings = z.infer<typeof rateSettingsSchema>;

/** `POST /api/admin/rate-settings`: a whole new version. */
export const changeRateSettingsSchema = rateSettingsValuesSchema
  .extend({})
  .meta({ id: 'ChangeRateSettings' });

/** SR3: a figure more than 20% from the current rate is never used. */
export const RATE_OUT_OF_RANGE_BPS = 2000;

/** SR3: true when a source's figure is within ±20% of the current rate. */
export function isFigureInRange(currentRate: string, figure: string): boolean {
  return basisPointsBetween(currentRate, figure) <= RATE_OUT_OF_RANGE_BPS;
}

/**
 * SR4: when a source's newest `ok` figure appeared: its post time, else when that figure was first
 * seen (the oldest read of it since the source last gave another figure, looked up in full by the
 * caller, never within a window of reads).
 */
export function figureSeenAt(newest: { postedAt: Date | null }, firstSeenAt: Date): Date {
  return newest.postedAt ?? firstSeenAt;
}

/** SR4: a figure is fresh while it appeared within `minutes` of `now`. */
export function isFreshFigure(seenAt: Date, now: Date, minutes: number): boolean {
  return seenAt.getTime() >= now.getTime() - minutes * 60_000;
}

/**
 * S27 data: a source handle as stored, so one channel or page is one source. Telegram usernames
 * ignore case and may be typed with `@`; a page path drops a trailing `/`.
 */
export function normaliseRateSourceHandle(kind: RateSourceKind, handle: string): string {
  const trimmed = handle.trim();
  return kind === 'telegram_channel'
    ? trimmed.replace(/^@/, '').toLowerCase()
    : trimmed.length > 1
      ? trimmed.replace(/\/+$/, '')
      : trimmed;
}

/** One fresh figure in a decision run (AU2). */
export interface DecisionFigure {
  observationId: string;
  sypPerUsd: string;
}

export type RateDecision =
  | { kind: 'none' }
  | { kind: 'auto'; sypPerUsd: string; changeBps: number; observationIds: string[] }
  | {
      kind: 'suggest';
      sypPerUsd: string;
      changeBps: number;
      reason: RateSuggestionReason;
      observationIds: string[];
    };

/**
 * S27 AU2–AU6 after a poll, pure. `driftBase` is the rate in force `driftWindowHours` ago (or the
 * oldest rate when younger); `pending` the value of the pending suggestion; `rejected` the values
 * rejected within 6 hours (SG4). Proposes the highest fresh figure (decision 5); applies it alone
 * only when automatic updates are on, enough sources agree, and the move and the drift are small.
 */
export function decideRate(input: {
  current: string;
  driftBase: string;
  figures: readonly DecisionFigure[];
  settings: RateSettingsValues;
  pending: string | null;
  rejected: readonly string[];
}): RateDecision {
  const { figures, settings } = input;
  const sorted = [...figures].sort((a, b) => compareRates(a.sypPerUsd, b.sypPerUsd));
  const lowest = sorted[0];
  const highest = sorted.at(-1);
  if (!lowest || !highest) return { kind: 'none' };
  const proposed = highest.sypPerUsd;
  const changeBps = basisPointsBetween(input.current, proposed);
  if (changeBps < settings.minMoveBps) return { kind: 'none' };
  const observationIds = figures.map((figure) => figure.observationId);
  const reason = suggestionReason({
    settings,
    count: figures.length,
    spreadBps: basisPointsBetween(lowest.sypPerUsd, proposed),
    changeBps,
    driftBps: basisPointsBetween(input.driftBase, proposed),
  });
  if (reason === null) return { kind: 'auto', sypPerUsd: proposed, changeBps, observationIds };
  const near = (value: string) => basisPointsBetween(value, proposed) < settings.minMoveBps;
  // AU6: the pending card stays while the value barely moved; SG4: a rejection is not re-asked.
  if (input.pending !== null && near(input.pending)) return { kind: 'none' };
  if (input.rejected.some(near)) return { kind: 'none' };
  return { kind: 'suggest', sypPerUsd: proposed, changeBps, reason, observationIds };
}

function suggestionReason(input: {
  settings: RateSettingsValues;
  count: number;
  spreadBps: number;
  changeBps: number;
  driftBps: number;
}): RateSuggestionReason | null {
  const { settings } = input;
  if (!settings.autoEnabled) return 'auto_off';
  if (input.count < settings.minAgreeingSources) return 'single_source';
  if (input.spreadBps > settings.agreementMaxSpreadBps) return 'sources_disagree';
  if (input.changeBps > settings.autoMaxMoveBps) return 'move_too_large';
  if (input.driftBps > settings.driftMaxBps) return 'drift_too_large';
  return null;
}

/**
 * SG1, SG2: true when Telegram may approve `proposed` while `current` is in force: within the
 * settings' cap and never above 5% (ADR 0041).
 */
export function telegramMayApproveRate(
  current: string,
  proposed: string,
  settings: Pick<RateSettingsValues, 'telegramApproveMaxBps'>,
): boolean {
  const cap = Math.min(settings.telegramApproveMaxBps, TELEGRAM_RATE_APPROVE_CEILING_BPS);
  return basisPointsBetween(current, proposed) <= cap;
}

/** `GET /api/admin/rates`: the current rate, staleness (FX7), the S27 state, and the history. */
export const ratesOverviewSchema = z
  .object({
    current: exchangeRateRecordSchema.nullable(),
    /** No rate yet counts as stale. */
    stale: z.boolean(),
    pendingSuggestion: rateSuggestionSchema.nullable(),
    autoEnabled: z.boolean(),
    history: ratePageSchema,
  })
  .meta({ id: 'RatesOverview' });

export type RatesOverview = z.infer<typeof ratesOverviewSchema>;
