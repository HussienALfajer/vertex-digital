import {
  approveRateSuggestionSchema,
  createRateSourceSchema,
  DEFAULT_RATE_SETTINGS,
  type ExchangeRateRecord,
  parseSourceFigure,
  type RateSettings,
  type RateSource,
  type RateSourceTestResult,
  type RateSuggestion,
  rateChangePercent,
  rateConfirmationError,
  rateSettingsValuesSchema,
  rateSourceHealth,
  testRateSourceSchema,
  updateRateSourceSchema,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';

/*
 * S27's automatic exchange-rate updates as the panel sees them: sources with their last reads, a
 * test read answered from scripted pages through the contracts' `parseSourceFigure`, a pending
 * suggestion approved (FX2's typed confirmation through `rateConfirmationError`) or rejected, and
 * the settings saved whole.
 */

type Body = Record<string, unknown> | null;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
export const rateId = (n: number) => `0199e700-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const validation = (issues: unknown): Answer => error(400, 'VALIDATION_FAILED', { issues });

export class RatesMock {
  /** Live sources: one channel reading, one page failing (broken). */
  sources: RateSource[] = [
    {
      id: rateId(1),
      kind: 'telegram_channel',
      label: 'قناة أسعار دمشق',
      handle: 'damascus_rates',
      parser: { cityWord: 'دمشق', sellWord: 'مبيع', unit: 'new_syp' },
      enabled: true,
      health: 'ok',
      observations: [
        {
          id: rateId(11),
          fetchedAt: at(3),
          postedAt: at(20),
          status: 'ok',
          sypPerUsd: '131.5',
          excerpt: 'دمشق: شراء 130.5 | مبيع 131.5',
          errorCode: null,
        },
        {
          id: rateId(12),
          fetchedAt: at(18),
          postedAt: at(20),
          status: 'ok',
          sypPerUsd: '131.5',
          excerpt: 'دمشق: شراء 130.5 | مبيع 131.5',
          errorCode: null,
        },
      ],
      createdAt: at(60 * 24 * 3),
      updatedAt: at(60 * 24 * 3),
      archivedAt: null,
    },
    {
      id: rateId(2),
      kind: 'sp_today_page',
      label: 'الليرة اليوم',
      handle: '/currency/us-dollar',
      parser: { cityWord: null, sellWord: 'بيع', unit: 'new_syp' },
      enabled: false,
      health: 'broken',
      observations: [3, 18, 33].map((minutes, index) => ({
        id: rateId(20 + index),
        fetchedAt: at(minutes),
        postedAt: null,
        status: 'fetch_failed' as const,
        sypPerUsd: null,
        excerpt: null,
        errorCode: 'http_403',
      })),
      createdAt: at(60 * 24 * 2),
      updatedAt: at(60 * 24),
      archivedAt: null,
    },
  ];
  /** The pending suggestion, if any; a test sets its own. */
  pending: RateSuggestion | null = null;
  settings: RateSettings = {
    ...DEFAULT_RATE_SETTINGS,
    id: null,
    adminName: null,
    createdAt: null,
  };
  /** The page a test read answers, by handle (the fake feed of the mock). */
  pages = new Map<string, string>([['damascus_rates', 'دمشق: شراء 130 | مبيع 131']]);

  constructor(
    private readonly reauthenticationRequired: () => boolean,
    private readonly rates: () => ExchangeRateRecord[],
    private readonly addRate: (rate: ExchangeRateRecord) => void,
  ) {}

  /** A pending suggestion of `proposed` against the rate in force. */
  suggest(proposed: string, reason: RateSuggestion['reason'] = 'single_source') {
    const base = this.rates()[0];
    if (!base) throw new Error('No rate to suggest against');
    this.pending = {
      id: rateId(50),
      proposedSypPerUsd: proposed,
      baseRateId: base.id,
      baseSypPerUsd: base.sypPerUsd,
      changePercent: rateChangePercent(base.sypPerUsd, proposed),
      reason,
      figures: [{ sourceLabel: 'قناة أسعار دمشق', sypPerUsd: proposed, at: at(12) }],
      status: 'pending',
      decidedAt: null,
      decidedChannel: null,
      adminName: null,
      appliedRateId: null,
      createdAt: at(10),
    };
  }

  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;
    if (path === '/api/admin/rate-sources' && method === 'GET') {
      return { status: 200, json: { items: this.sources } };
    }
    if (path === '/api/admin/rate-sources' && method === 'POST') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = createRateSourceSchema.safeParse(body);
      if (!parsed.success) return validation(parsed.error.issues);
      if (
        this.sources.some((s) => s.kind === parsed.data.kind && s.handle === parsed.data.handle)
      ) {
        return error(400, 'RATE_SOURCE_INVALID');
      }
      const source: RateSource = {
        id: rateId(100 + this.sources.length),
        ...parsed.data,
        parser: parsed.data.parser,
        health: 'unknown',
        observations: [],
        createdAt: at(0),
        updatedAt: at(0),
        archivedAt: null,
      };
      this.sources = [...this.sources, source];
      return { status: 201, json: source };
    }
    if (path === '/api/admin/rate-sources/test' && method === 'POST') {
      const parsed = testRateSourceSchema.safeParse(body);
      if (!parsed.success) return validation(parsed.error.issues);
      const page = this.pages.get(parsed.data.handle);
      const result: RateSourceTestResult = (() => {
        if (page === undefined) {
          return {
            status: 'fetch_failed',
            sypPerUsd: null,
            postedAt: null,
            excerpt: null,
            errorCode: 'http_404',
          };
        }
        const figure = parseSourceFigure(page, parsed.data.parser);
        return figure
          ? {
              status: 'ok',
              sypPerUsd: figure.sypPerUsd,
              postedAt: at(5),
              excerpt: figure.excerpt,
              errorCode: null,
            }
          : { status: 'no_match', sypPerUsd: null, postedAt: null, excerpt: null, errorCode: null };
      })();
      return { status: 200, json: result };
    }
    const sourceMatch = path.match(/^\/api\/admin\/rate-sources\/([^/]+)(\/archive)?$/);
    if (sourceMatch) {
      const refused = sensitive();
      if (refused) return refused;
      const source = this.sources.find((item) => item.id === sourceMatch[1]);
      if (!source) return error(404, 'NOT_FOUND');
      if (sourceMatch[2] && method === 'POST') {
        this.sources = this.sources.filter((item) => item.id !== source.id);
        return { status: 200, json: { ...source, enabled: false, archivedAt: at(0) } };
      }
      if (method === 'PATCH') {
        const parsed = updateRateSourceSchema.safeParse(body);
        if (!parsed.success) return validation(parsed.error.issues);
        const updated = { ...source, ...parsed.data, updatedAt: at(0) };
        updated.health = rateSourceHealth(updated.observations);
        this.sources = this.sources.map((item) => (item.id === source.id ? updated : item));
        return { status: 200, json: updated };
      }
    }
    const decision = path.match(/^\/api\/admin\/rate-suggestions\/([^/]+)\/(approve|reject)$/);
    if (decision && method === 'POST') {
      if (!this.pending || this.pending.id !== decision[1]) {
        return error(409, 'RATE_SUGGESTION_STATE_CONFLICT');
      }
      const suggestion = this.pending;
      if (decision[2] === 'reject') {
        this.pending = null;
        return {
          status: 200,
          json: { ...suggestion, status: 'rejected', decidedAt: at(0), decidedChannel: 'panel' },
        };
      }
      const refused = sensitive();
      if (refused) return refused;
      const parsed = approveRateSuggestionSchema.safeParse(body ?? {});
      if (!parsed.success) return validation(parsed.error.issues);
      const current = this.rates()[0] ?? null;
      const value = parsed.data.sypPerUsd ?? suggestion.proposedSypPerUsd;
      const confirmation = rateConfirmationError(current?.sypPerUsd ?? null, {
        sypPerUsd: value,
        rateConfirmation: parsed.data.rateConfirmation,
      });
      if (confirmation) return error(400, confirmation);
      const record: ExchangeRateRecord = {
        id: rateId(200 + this.rates().length),
        origin: 'suggestion',
        sypPerUsd: value,
        displayStepSypUnits: current?.displayStepSypUnits ?? 500,
        changePercent: current ? rateChangePercent(current.sypPerUsd, value) : null,
        adminName: 'ريم الخطيب',
        createdAt: at(0),
      };
      this.addRate(record);
      this.pending = null;
      return { status: 201, json: record };
    }
    if (path === '/api/admin/rate-suggestions' && method === 'GET') {
      return { status: 200, json: { items: this.pending ? [this.pending] : [], nextCursor: null } };
    }
    if (path === '/api/admin/rate-settings' && method === 'GET') {
      return { status: 200, json: this.settings };
    }
    if (path === '/api/admin/rate-settings' && method === 'POST') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = rateSettingsValuesSchema.safeParse(body);
      if (!parsed.success) return validation(parsed.error.issues);
      this.settings = {
        ...parsed.data,
        id: rateId(300),
        adminName: 'ريم الخطيب',
        createdAt: at(0),
      };
      return { status: 201, json: this.settings };
    }
    return null;
  }
}
