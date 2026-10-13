import {
  correctionEndpoints,
  createSupplierCorrectionSchema,
  createTreasuryMovementSchema,
  heldUnits,
  type MoneyPlaces,
  type OpenMismatch,
  type ReconciliationOverview,
  type ReconciliationResult,
  type ReconciliationRun,
  type ReconciliationRunDetail,
  type ReconciliationSettings,
  type Report,
  type ReportKind,
  reconciliationSettingsSchema,
  reportPeriodError,
  reverseTreasuryMovementSchema,
  shamCashCountSchema,
  TREASURY_ACCOUNTS,
  TREASURY_PLACES,
  type TreasuryEndpoint,
  type TreasuryMovement,
  type TreasuryPlace,
  treasuryConfirmationError,
  treasuryMovementError,
  treasuryPostings,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';

/*
 * The books (S13) as `/api/admin/reconciliation`, `/api/admin/treasury` and `/api/admin/reports`
 * answer them: movements posted with the contracts' own rules (T2–T9, M1–M4), each place's books
 * from those postings, an outside balance per place, runs, open mismatches, counts, settings and
 * the reports. Empty by default (no run yet); `seed()` gives the screenshots an open mismatch.
 */

type Body = Record<string, unknown> | null;

const USD = 1_000_000;

const error = (status: number, code: string): Answer => ({
  status,
  json: { statusCode: status, code, message: code },
});

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const RUN_IDS = { nightly: id(1), previous: id(2) };
export const RESULT_IDS = { supplier: id(11), internal: id(12) };
export const OPENED_ORDER_ID = '0199b000-0000-7000-8000-000000000001';

const noDetails = { offending: [], lines: [], reason: null };

const result = (
  values: Partial<ReconciliationResult> & Pick<ReconciliationResult, 'id' | 'check' | 'subject'>,
): ReconciliationResult => ({
  runId: RUN_IDS.nightly,
  status: 'ok',
  currency: null,
  booksUnits: null,
  actualUnits: null,
  differenceUnits: null,
  allowedLowUnits: null,
  allowedHighUnits: null,
  offendingCount: 0,
  details: noDetails,
  explanation: null,
  createdAt: at(600),
  ...values,
});

export class ReconciliationMock {
  movements: TreasuryMovement[] = [];
  /** The newest balance read or counted outside the books, per place. */
  external: Partial<
    Record<TreasuryPlace, { units: number; at: string; source: 'supplier' | 'chain' | 'count' }>
  > = {
    'supplier:fake': { units: 200 * USD, at: at(4), source: 'supplier' },
    usdt_trc20: { units: 10 * USD, at: at(6), source: 'chain' },
  };
  runs: ReconciliationRunDetail[] = [];
  running: ReconciliationRun | null = null;
  open: OpenMismatch[] = [];
  settings: ReconciliationSettings = { toleranceUsdUnits: 1 * USD, countStaleDays: 7 };
  /** Report data by kind; a kind left out answers an empty report. */
  reports: Partial<Record<ReportKind, (from: string, to: string) => Report<ReportKind>>> = {};
  private readonly keys = new Map<string, TreasuryMovement>();
  private sequence = 100;

  constructor(private readonly reauthenticationRequired: () => boolean) {}

  /** The screenshots' state: last night found a supplier difference and a ledger fault. */
  seed() {
    const supplier = result({
      id: RESULT_IDS.supplier,
      check: 'supplier_balance',
      subject: 'supplier:fake',
      status: 'mismatch',
      currency: 'USD',
      booksUnits: 199_400_000,
      actualUnits: 150 * USD,
      differenceUnits: -49_400_000,
      allowedLowUnits: 199_400_000,
      allowedHighUnits: 199_400_000,
    });
    const internal = result({
      id: RESULT_IDS.internal,
      check: 'order_purchase',
      subject: 'ledger',
      status: 'mismatch',
      offendingCount: 1,
      details: { ...noDetails, offending: [{ kind: 'order', id: OPENED_ORDER_ID }] },
    });
    const warning = result({
      id: id(13),
      check: 'usdt_balance',
      subject: 'usdt_bep20',
      status: 'skipped',
      details: { ...noDetails, reason: 'opening_missing' },
    });
    const run: ReconciliationRunDetail = {
      id: RUN_IDS.nightly,
      trigger: 'schedule',
      businessDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      status: 'finished',
      startedAt: at(600),
      finishedAt: at(599),
      mismatchCount: 2,
      warningCount: 1,
      recheckAt: null,
      failure: null,
      results: [
        internal,
        result({ id: id(14), check: 'journal_balance', subject: 'ledger' }),
        supplier,
        warning,
      ],
    };
    this.runs = [run];
    this.open = [
      { ...internal, firstSeenAt: at(600) },
      { ...supplier, firstSeenAt: at(2000) },
    ];
  }

  private nextId() {
    this.sequence += 1;
    return id(this.sequence);
  }

  /** Rule LS2: what each place holds, from the postings of every movement. */
  private balance(place: TreasuryEndpoint): number {
    const account = TREASURY_ACCOUNTS[place];
    const raw = this.movements
      .flatMap((movement) =>
        treasuryPostings({ ...movement, reversal: movement.reversesMovementId !== null }),
      )
      .filter((posting) => posting.code === account.code)
      .reduce((sum, posting) => sum + posting.amountUnits, 0);
    return heldUnits(account.kind, raw);
  }

  private openingRecorded(place: TreasuryPlace): boolean {
    return this.movements.some(
      (movement) =>
        movement.openingBalance && movement.to === place && movement.reversedByMovementId === null,
    );
  }

  places(): MoneyPlaces {
    return {
      places: TREASURY_PLACES.map((place) => {
        const books = this.balance(place);
        const external = this.external[place] ?? null;
        const opened = this.openingRecorded(place);
        const proposed = external && !opened ? external.units - books : null;
        return {
          place,
          currency: TREASURY_ACCOUNTS[place].currency,
          booksUnits: books,
          external,
          differenceUnits: external ? external.units - books : null,
          openingRecorded: opened,
          proposedOpeningUnits: proposed !== null && proposed > 0 ? proposed : null,
        };
      }),
    };
  }

  overview(): ReconciliationOverview {
    const lastNightly = this.runs.find(
      (run) => run.trigger === 'schedule' && run.status !== 'running',
    );
    const lastFinished = this.runs.find(
      (run) => run.status === 'finished' && run.trigger !== 'count',
    );
    const counts = this.runs
      .filter((run) => run.trigger === 'count')
      .flatMap((run) => run.results)
      .filter(
        (item, index, all) => all.findIndex((other) => other.subject === item.subject) === index,
      );
    const { results: _results, ...last } = lastNightly ?? { results: [] };
    return {
      lastNightly: lastNightly ? (last as ReconciliationRun) : null,
      lastRun: (() => {
        const newest = this.runs.find((run) => run.status !== 'running');
        if (!newest) return null;
        const { results: _newestResults, ...run } = newest;
        return run;
      })(),
      running: this.running,
      openMismatches: this.open,
      warnings: (lastFinished?.results ?? []).filter(
        (item) =>
          item.status === 'warning' ||
          (item.status === 'skipped' && item.details.reason !== 'currency_unsupported'),
      ),
      shamCashCounts: counts.map((item) => ({
        currency: item.subject === 'sham_cash_syp' ? 'SYP' : 'USD',
        countedUnits: item.actualUnits ?? 0,
        at: item.createdAt,
        status: item.status,
      })),
      settings: this.settings,
      manualAvailableAt: null,
    };
  }

  private record(
    key: string | null,
    input: Omit<
      TreasuryMovement,
      'id' | 'journalId' | 'adminName' | 'createdAt' | 'feeUnits' | 'rate' | 'reversedByMovementId'
    >,
  ): Answer {
    if (key && this.keys.has(key)) return { status: 200, json: this.keys.get(key) };
    const sameCurrency = input.sentCurrency === input.receivedCurrency;
    const movement: TreasuryMovement = {
      ...input,
      id: this.nextId(),
      feeUnits: sameCurrency ? input.sentUnits - input.receivedUnits : null,
      rate: null,
      reversedByMovementId: null,
      journalId: this.nextId(),
      adminName: 'ريم الخطيب',
      createdAt: new Date().toISOString(),
    };
    this.movements = [movement, ...this.movements];
    if (key) this.keys.set(key, movement);
    return { status: 201, json: movement };
  }

  answer(method: string, url: URL, body: Body, idempotencyKey: string | null): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    if (key === 'GET /api/admin/reconciliation/counts') {
      return { status: 200, json: { open: this.open.length } };
    }
    if (key === 'GET /api/admin/reconciliation') return { status: 200, json: this.overview() };
    if (key === 'GET /api/admin/reconciliation/settings') {
      return { status: 200, json: this.settings };
    }
    if (key === 'PUT /api/admin/reconciliation/settings') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = reconciliationSettingsSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      this.settings = parsed.data;
      return { status: 200, json: this.settings };
    }
    if (key === 'POST /api/admin/reconciliation/runs') {
      if (this.running) return error(409, 'RECONCILIATION_RUNNING');
      this.running = {
        id: this.nextId(),
        trigger: 'manual',
        businessDate: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        mismatchCount: 0,
        warningCount: 0,
        recheckAt: null,
        failure: null,
      };
      return { status: 202, json: this.running };
    }
    if (key === 'GET /api/admin/reconciliation/runs') {
      const items = [...(this.running ? [this.running] : []), ...this.runs].map(
        ({ results: _results, ...run }: ReconciliationRun & { results?: unknown }) => run,
      );
      return { status: 200, json: { items, nextCursor: null } };
    }
    const runMatch = /^\/api\/admin\/reconciliation\/runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && runMatch) {
      const run = this.runs.find((item) => item.id === runMatch[1]);
      return run ? { status: 200, json: run } : error(404, 'NOT_FOUND');
    }
    const explainMatch = /^\/api\/admin\/reconciliation\/results\/([^/]+)\/explanation$/.exec(path);
    if (method === 'POST' && explainMatch) {
      const open = this.open.find((item) => item.id === explainMatch[1]);
      if (!open) return error(409, 'RESULT_NOT_EXPLAINABLE');
      const note = String(body?.note ?? '').trim();
      if (note.length < 5) return error(400, 'VALIDATION_FAILED');
      this.open = this.open.filter((item) => item.id !== open.id);
      const { firstSeenAt: _first, ...explained } = open;
      return {
        status: 201,
        json: {
          ...explained,
          explanation: { note, adminName: 'ريم الخطيب', createdAt: new Date().toISOString() },
        },
      };
    }
    if (key === 'POST /api/admin/reconciliation/sham-cash-counts') {
      const parsed = shamCashCountSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const place: TreasuryPlace =
        parsed.data.currency === 'SYP' ? 'sham_cash_syp' : 'sham_cash_usd';
      const books = this.balance(place);
      const difference = parsed.data.countedUnits - books;
      const opened = this.openingRecorded(place);
      const runId = this.nextId();
      const run: ReconciliationRunDetail = {
        id: runId,
        trigger: 'count',
        businessDate: null,
        status: 'finished',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        mismatchCount: opened && difference !== 0 ? 1 : 0,
        warningCount: opened ? 0 : 1,
        recheckAt: null,
        failure: null,
        results: [
          result({
            id: this.nextId(),
            runId,
            check: 'sham_cash_count',
            subject: place,
            status: !opened ? 'skipped' : difference === 0 ? 'ok' : 'mismatch',
            currency: parsed.data.currency,
            booksUnits: books,
            actualUnits: parsed.data.countedUnits,
            differenceUnits: difference,
            allowedLowUnits: books,
            allowedHighUnits: books,
            details: { ...noDetails, reason: opened ? null : 'opening_missing' },
            createdAt: new Date().toISOString(),
          }),
        ],
      };
      this.runs = [run, ...this.runs];
      this.external[place] = {
        units: parsed.data.countedUnits,
        at: new Date().toISOString(),
        source: 'count',
      };
      return { status: 201, json: run };
    }

    if (key === 'GET /api/admin/treasury/places') return { status: 200, json: this.places() };
    if (key === 'GET /api/admin/treasury/movements') {
      const place = url.searchParams.get('place');
      const items = this.movements.filter(
        (movement) => !place || movement.from === place || movement.to === place,
      );
      return { status: 200, json: { items, nextCursor: null } };
    }
    if (key === 'POST /api/admin/treasury/movements') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = createTreasuryMovementSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const input = parsed.data;
      const invalid = treasuryMovementError(input);
      if (invalid) return error(400, invalid);
      const confirmation = treasuryConfirmationError(
        input.sentUnits,
        TREASURY_ACCOUNTS[input.from].currency === 'USD' ? input.sentUnits : null,
        input.amountConfirmationUnits,
      );
      if (confirmation) return error(400, confirmation);
      if (input.openingBalance && this.movements.some((item) => item.to === input.to)) {
        return error(409, 'OPENING_BALANCE_EXISTS');
      }
      return this.record(idempotencyKey, {
        kind: 'transfer',
        from: input.from,
        to: input.to,
        sentUnits: input.sentUnits,
        sentCurrency: TREASURY_ACCOUNTS[input.from].currency,
        receivedUnits: input.receivedUnits,
        receivedCurrency: TREASURY_ACCOUNTS[input.to].currency,
        outsideCategory: input.outsideCategory ?? null,
        openingBalance: input.openingBalance,
        order: null,
        externalReference: input.externalReference ?? null,
        reason: input.reason,
        reversesMovementId: null,
      });
    }
    if (key === 'POST /api/admin/treasury/supplier-corrections') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = createSupplierCorrectionSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const input = parsed.data;
      const confirmation = treasuryConfirmationError(
        input.amountUnits,
        input.amountUnits,
        input.amountConfirmationUnits,
      );
      if (confirmation) return error(400, confirmation);
      const { from, to } = correctionEndpoints(input.supplier, input.direction);
      return this.record(idempotencyKey, {
        kind: 'supplier_correction',
        from,
        to,
        sentUnits: input.amountUnits,
        sentCurrency: 'USD',
        receivedUnits: input.amountUnits,
        receivedCurrency: 'USD',
        outsideCategory: null,
        openingBalance: false,
        order: null,
        externalReference: input.externalReference ?? null,
        reason: input.reason,
        reversesMovementId: null,
      });
    }
    const reverseMatch = /^\/api\/admin\/treasury\/movements\/([^/]+)\/reverse$/.exec(path);
    if (method === 'POST' && reverseMatch) {
      const refused = sensitive();
      if (refused) return refused;
      const original = this.movements.find((item) => item.id === reverseMatch[1]);
      if (!original) return error(404, 'NOT_FOUND');
      if (original.reversesMovementId) return error(409, 'MOVEMENT_NOT_REVERSIBLE');
      if (original.reversedByMovementId) return error(409, 'MOVEMENT_ALREADY_REVERSED');
      const parsed = reverseTreasuryMovementSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const confirmation = treasuryConfirmationError(
        original.sentUnits,
        original.sentCurrency === 'USD' ? original.sentUnits : null,
        parsed.data.amountConfirmationUnits,
      );
      if (confirmation) return error(400, confirmation);
      const answer = this.record(idempotencyKey, {
        ...original,
        externalReference: null,
        reason: parsed.data.reason,
        reversesMovementId: original.id,
      });
      if (answer.status === 201 && 'json' in answer) {
        original.reversedByMovementId = (answer.json as TreasuryMovement).id;
      }
      return answer;
    }

    const reportMatch = /^\/api\/admin\/reports\/([a-z]+)$/.exec(path);
    if (method === 'GET' && reportMatch) {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (reportPeriodError(from, to)) return error(400, 'REPORT_PERIOD_INVALID');
      const kind = reportMatch[1] as ReportKind;
      const build = this.reports[kind];
      return { status: 200, json: build ? build(from, to) : emptyReport(kind, from, to, url) };
    }
    return null;
  }
}

/** A report of a period without data, as the API answers it. */
function emptyReport(kind: ReportKind, from: string, to: string, url: URL): Report<ReportKind> {
  const period = { from, to, generatedAt: new Date().toISOString() };
  const sales = {
    delivered: 0,
    salesUsdUnits: 0,
    costUsdUnits: 0,
    profitUsdUnits: 0,
    marginPercent: null,
  };
  switch (kind) {
    case 'sales':
      return { ...period, rows: [], totals: sales, ownerFunded: sales };
    case 'breakdown':
      return {
        ...period,
        by: (url.searchParams.get('by') ?? 'game') as 'game',
        rows: [],
        totals: {
          ...sales,
          deliveredUnits: 0,
          attemptsSent: null,
          attemptsFailed: null,
          failureRatePercent: null,
        },
        ownerFunded: sales,
      };
    case 'deposits':
      return {
        ...period,
        rows: [],
        manualDeposits: { count: 0, usdUnits: 0 },
        totals: { credited: 0, creditedUsdUnits: 0, rejected: 0, expired: 0 },
      };
    case 'refunds':
      return {
        ...period,
        byReason: [],
        products: [],
        suppliers: [],
        totals: { orders: 0, usdUnits: 0 },
      };
    case 'customers':
      return {
        ...period,
        rows: [],
        totals: { delivered: 0, salesUsdUnits: 0, profitUsdUnits: 0, depositsUsdUnits: 0 },
      };
    default:
      return {
        ...period,
        rows: [],
        totals: [],
        places: [],
        ownerDrawings: { startUnits: 0, endUnits: 0 },
      };
  }
}
