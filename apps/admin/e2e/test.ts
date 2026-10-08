import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import {
  type AuditEntry,
  approvalFlags,
  approvalNeedsReauthentication,
  DEPOSIT_SETTINGS_DEFAULTS,
  depositCreditUsdUnits,
  floorToWholeCents,
  rateChangePercent,
  rateConfirmationError,
  STORE_SWITCH_DEFAULTS,
  STORE_SWITCHES,
  type StoreSwitch,
  type SwitchChange,
  type TelegramLinkStatus,
} from '@vertex-digital/contracts';
import openapi from '../../api/openapi.json' with { type: 'json' };

/*
 * The `test` every admin spec uses: Playwright's, with a mocked API (`admin`) and failing a test
 * when the page throws, React or Base UI log an error, or the page calls a route the mock does not
 * answer or the API does not declare (`apps/api/openapi.json`; Better Auth routes are outside it).
 */

type Route = Parameters<Parameters<Page['route']>[1]>[0];

export const TOTP_CODE = '123456';
export const BACKUP_CODE = 'abcde-fghjk';
export const PASSWORD = 'correct-horse-battery';
export const NEW_PASSWORD = 'a7Kq-blue-moon-river';
/** What the API would generate for a test customer: a test value only. */
export const GENERATED_PASSWORD = 'b8Lr-green-sea-lake';

export const ADMIN_ID = '0199a000-0000-7000-8000-000000000001';
export const CUSTOMER_ID = '0199a000-0000-7000-8000-000000000010';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Audit entries newest first: each kind of actor, and a change with before and after. */
export const AUDIT_ENTRIES = [
  {
    id: '0199a000-0000-7000-8000-0000000000e4',
    occurredAt: '2026-10-08T09:30:00.000Z',
    actorKind: 'customer',
    actorId: CUSTOMER_ID,
    actorName: 'سارة الأحمد',
    channel: 'store',
    action: 'customer.profile_updated',
    entityType: 'customer',
    entityId: CUSTOMER_ID,
    reason: null,
    details: {
      before: { name: 'سارة', phone: '+963944123456' },
      after: { name: 'سارة الأحمد', phone: '+963933000111' },
    },
    ipAddress: '5.0.0.1',
    userAgent: CHROME_WINDOWS,
  },
  {
    id: '0199a000-0000-7000-8000-0000000000e3',
    occurredAt: '2026-10-08T09:00:00.000Z',
    actorKind: 'admin',
    actorId: ADMIN_ID,
    actorName: 'ريم الخطيب',
    channel: 'admin',
    action: 'customer.test_created',
    entityType: 'customer',
    entityId: CUSTOMER_ID,
    reason: null,
    details: { name: 'سارة الأحمد', email: 'sara@example.com', phone: '+963944123456' },
    ipAddress: '5.0.0.9',
    userAgent: CHROME_WINDOWS,
  },
  {
    id: '0199a000-0000-7000-8000-0000000000e2',
    occurredAt: '2026-10-07T20:00:00.000Z',
    actorKind: 'admin',
    actorId: ADMIN_ID,
    actorName: 'ريم الخطيب',
    channel: 'admin',
    action: 'admin.signed_in',
    entityType: 'admin_user',
    entityId: ADMIN_ID,
    reason: null,
    details: {},
    ipAddress: '5.0.0.9',
    userAgent: CHROME_WINDOWS,
  },
  {
    id: '0199a000-0000-7000-8000-0000000000e1',
    occurredAt: '2026-10-07T19:00:00.000Z',
    actorKind: 'cli',
    actorId: null,
    actorName: null,
    channel: 'cli',
    action: 'admin.created',
    entityType: 'admin_user',
    entityId: ADMIN_ID,
    reason: null,
    details: { name: 'ريم الخطيب', email: 'reem@example.com' },
    ipAddress: null,
    userAgent: null,
  },
];

/** The mock's audit page size: small, so "load more" shows. */
export const AUDIT_PAGE_SIZE = 3;

const declared = Object.entries(openapi.paths as Record<string, Record<string, unknown>>).map(
  ([path, operations]) => ({
    pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
    methods: new Set(Object.keys(operations).map((method) => method.toUpperCase())),
  }),
);

const WALLET_PATH = /^\/api\/admin\/wallets\/([^/]+)$/;
const WALLET_ENTRIES_PATH = /^\/api\/admin\/wallets\/([^/]+)\/entries$/;
const ADJUSTMENTS_PATH = /^\/api\/admin\/wallets\/([^/]+)\/adjustments$/;
const REVERSE_PATH = /^\/api\/admin\/wallet-adjustments\/([^/]+)\/reverse$/;
const RESET_PASSWORD_PATH = /^\/api\/admin\/test-customers\/[^/]+\/reset-password$/;
const OWN_SESSION_PATH = /^\/api\/admin\/me\/sessions\/([^/]+)$/;
const DEPOSIT_PATH = /^\/api\/admin\/deposits\/([^/]+)$/;
const DEPOSIT_ACTION_PATH =
  /^\/api\/admin\/deposits\/([^/]+)\/(approve|approve-usdt|reject|request-receipt|recheck)$/;
const RECEIPT_PATH = /^\/api\/admin\/deposits\/[^/]+\/receipts\/[^/]+$/;
const QR_PATH = /^\/api\/admin\/deposit-settings\/qr\/[^/]+$/;

/** A 1×1 PNG: what the receipt and QR routes answer in tests. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** One USD in micro-dollars (ADR 0003). */
export const USD = 1_000_000;

/** The wallet the S02 specs read and adjust: a test customer's. */
export const WALLET_CUSTOMER = {
  id: CUSTOMER_ID,
  name: 'سارة الأحمد',
  email: 'sara@example.com',
  phone: '+963944123456',
  isTest: true,
};

interface Adjustment {
  id: string;
  direction: 'credit' | 'debit';
  amountUnits: number;
  category: string;
  reason: string;
  customerNote: string | null;
  depositMethod: string | null;
  externalReference: string | null;
  reversesAdjustmentId: string | null;
  createdAt: string;
  balanceAfterUnits: number;
}

export interface RateRecord {
  id: string;
  sypPerUsd: string;
  displayStepSypUnits: number;
  changePercent: string | null;
  adminName: string | null;
  createdAt: string;
}

/** A deposit as `GET /api/admin/deposits/:id` answers it (S03). */
export type MockDeposit = Record<string, unknown> & {
  id: string;
  status: string;
  currency: 'SYP' | 'USD';
  declaredAmountUnits: number;
  receiptRequestCount: number;
  approvalRate: { rateId: string; rate: string } | null;
  flags: (Record<string, unknown> & { code: string })[];
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

interface TestCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
}

/**
 * The admin Better Auth instance and the API as the panel sees them, with the state a sign-in
 * moves through: signed out, waiting for the TOTP step, signed in (with or without TOTP), and the
 * S01 account state (password change, idle expiry, re-authentication).
 */
export class AdminApi {
  readonly unexpected: string[] = [];
  readonly calls: string[] = [];
  readonly bodies: { key: string; body: unknown }[] = [];
  readonly requests: { key: string; headers: Record<string, string> }[] = [];
  user = {
    id: ADMIN_ID,
    name: 'ريم الخطيب',
    email: 'reem@example.com',
    twoFactorEnabled: true,
    mustChangePassword: false,
  };
  signedIn = false;
  /** Answers the next sign-in with `ALTCHA_REQUIRED` unless it carries a solved challenge. */
  altchaRequired = false;
  /** The next API request finds the session idle for 30 minutes (rule D4). */
  idleExpired = false;
  /** Sensitive routes answer `REAUTHENTICATION_REQUIRED` until a re-authentication (rule D5). */
  reauthenticationRequired = false;
  testCustomers: TestCustomer[] = [];
  sessions = [
    {
      id: '0199a000-0000-7000-8000-0000000000a1',
      createdAt: '2026-10-08T08:00:00.000Z',
      lastActiveAt: '2026-10-08T09:40:00.000Z',
      expiresAt: '2026-10-08T20:00:00.000Z',
      ipAddress: '5.0.0.9',
      userAgent: CHROME_WINDOWS,
      current: true,
    },
    {
      id: '0199a000-0000-7000-8000-0000000000a2',
      createdAt: '2026-10-08T07:00:00.000Z',
      lastActiveAt: '2026-10-08T07:10:00.000Z',
      expiresAt: '2026-10-08T19:00:00.000Z',
      ipAddress: '5.0.0.7',
      userAgent: SAFARI_IPHONE,
      current: false,
    },
  ];
  /** The wallet's adjustments, oldest first, and the request keys already answered (rule J9). */
  adjustments: Adjustment[] = [];
  private readonly adjustmentKeys = new Map<string, Adjustment>();
  private pendingTwoFactor = false;
  /** The exchange rates, newest first: one set an hour ago, so the stale banner stays hidden. */
  rates: RateRecord[] = [
    {
      id: '0199a000-0000-7000-8000-0000000000f1',
      sypPerUsd: '118',
      displayStepSypUnits: 500,
      changePercent: null,
      adminName: 'ريم الخطيب',
      createdAt: hoursAgo(1),
    },
  ];
  /** The audit log, newest first; a test adds its own entries (S05: a decision from Telegram). */
  auditEntries: AuditEntry[] = [...AUDIT_ENTRIES] as AuditEntry[];
  /** The store switch changes, newest first (S05 rule SW1): none, so every switch has its default. */
  switchChanges: SwitchChange[] = [];
  /** The Telegram bot (S05 F07): configured, no chat linked, nothing sent yet. */
  telegram: TelegramLinkStatus = { configured: true, link: null, lastMessage: null };
  /** The deposit settings: the defaults until the first save (rule SC1). */
  depositSettings: Record<string, unknown> = {
    ...DEPOSIT_SETTINGS_DEFAULTS,
    saved: false,
    savedAt: null,
    // S04: the server's USDT addresses, read-only in the panel.
    usdt: [
      { method: 'usdt_trc20', address: null, lastScanAt: null, delayed: true },
      { method: 'usdt_bep20', address: null, lastScanAt: null, delayed: true },
    ],
  };
  /** The deposits the queue and the review pages read (S03). */
  deposits: MockDeposit[] = [];
  /** S04: the recorded USDT transfers, newest first, with their holder and candidates. */
  usdtTransfers: (Record<string, unknown> & { id: string; txid: string; method: string })[] = [];
  /** The transaction numbers already claimed (rule SC14). */
  readonly claimedReferences = new Set<string>();
  private readonly decisionKeys = new Map<string, string>();

  /** The wallet's balance: the sum of its adjustments. */
  get balanceUnits(): number {
    return this.adjustments.reduce(
      (sum, item) => sum + (item.direction === 'credit' ? item.amountUnits : -item.amountUnits),
      0,
    );
  }

  /** Writes an adjustment the way the API does (rules J5, J6, J8, J9), or answers its refusal. */
  private adjust(
    key: string | undefined,
    input: Omit<Adjustment, 'id' | 'createdAt' | 'balanceAfterUnits'>,
    confirmation: unknown,
  ) {
    if (!key) return { status: 400, code: 'VALIDATION_FAILED' } as const;
    const replay = this.adjustmentKeys.get(key);
    if (replay) return { status: 200, adjustment: replay } as const;
    if (input.amountUnits > 100 * USD && confirmation === undefined) {
      return { status: 400, code: 'AMOUNT_CONFIRMATION_REQUIRED' } as const;
    }
    if (confirmation !== undefined && confirmation !== input.amountUnits) {
      return { status: 400, code: 'AMOUNT_CONFIRMATION_MISMATCH' } as const;
    }
    const reference = input.externalReference?.trim().toUpperCase();
    if (
      reference &&
      this.adjustments.some(
        (item) =>
          item.depositMethod === input.depositMethod &&
          item.externalReference?.trim().toUpperCase() === reference,
      )
    ) {
      return { status: 409, code: 'EXTERNAL_REFERENCE_TAKEN' } as const;
    }
    if (input.direction === 'debit' && input.amountUnits > this.balanceUnits) {
      return {
        status: 409,
        code: 'INSUFFICIENT_BALANCE',
        balanceUnits: this.balanceUnits,
      } as const;
    }
    const index = this.adjustments.length + 1;
    const adjustment: Adjustment = {
      ...input,
      id: `0199a000-0000-7000-8000-0000000000${(0xb0 + index).toString(16)}`,
      createdAt: new Date(Date.UTC(2026, 9, 8, 9, index)).toISOString(),
      balanceAfterUnits:
        this.balanceUnits + (input.direction === 'credit' ? input.amountUnits : -input.amountUnits),
    };
    this.adjustments.push(adjustment);
    this.adjustmentKeys.set(key, adjustment);
    return { status: 201, adjustment } as const;
  }

  /** The admin timeline of the wallet, newest first (rule W3). */
  private walletEntries() {
    return [...this.adjustments].reverse().map((item) => ({
      occurredAt: item.createdAt,
      kind: 'adjustment',
      amountUnits: item.direction === 'credit' ? item.amountUnits : -item.amountUnits,
      balanceAfterUnits: item.balanceAfterUnits,
      journalId: item.id.replace('-8000-', '-9000-'),
      adjustment: {
        id: item.id,
        direction: item.direction,
        category: item.category,
        customerNote: item.customerNote,
        reversal: item.reversesAdjustmentId !== null,
        reason: item.reason,
        adminName: this.user.name,
        depositMethod: item.depositMethod,
        externalReference: item.externalReference,
        reversesAdjustmentId: item.reversesAdjustmentId,
        reversedByAdjustmentId:
          this.adjustments.find((other) => other.reversesAdjustmentId === item.id)?.id ?? null,
      },
      deposit: null,
    }));
  }

  /** Every switch with its newest change, as `GET /api/admin/switches` answers. */
  switches() {
    return {
      switches: STORE_SWITCHES.map((name) => {
        const change = this.switchChanges.find((item) => item.switch === name);
        return {
          switch: name,
          value: change?.value ?? STORE_SWITCH_DEFAULTS[name],
          default: STORE_SWITCH_DEFAULTS[name],
          since: change?.createdAt ?? null,
          channel: change?.channel ?? null,
        };
      }),
    };
  }

  /** The switch routes of S05, or false when `path` is not one of them. */
  private async answerSwitches(
    route: Route,
    method: string,
    url: URL,
    body: Record<string, unknown> | null,
  ): Promise<boolean> {
    const json = async (status: number, value: unknown) => {
      await route.fulfill({ status, json: value });
      return true;
    };
    if (url.pathname === '/api/admin/switches' && method === 'GET') {
      return json(200, this.switches());
    }
    if (url.pathname === '/api/admin/switches' && method === 'POST') {
      if (this.reauthenticationRequired) {
        return json(403, {
          statusCode: 403,
          code: 'REAUTHENTICATION_REQUIRED',
          message: 'REAUTHENTICATION_REQUIRED',
        });
      }
      const input = body as { switch: StoreSwitch; value: boolean };
      const current = this.switches().switches.find((item) => item.switch === input.switch);
      if (current && current.value !== input.value) {
        this.switchChanges = [
          {
            id: `0199a000-0000-7000-8000-0000000005${this.switchChanges.length.toString().padStart(2, '0')}`,
            switch: input.switch,
            value: input.value,
            channel: 'admin',
            createdAt: new Date().toISOString(),
          },
          ...this.switchChanges,
        ];
      }
      return json(200, this.switches());
    }
    if (url.pathname === '/api/admin/switches/history' && method === 'GET') {
      const filter = url.searchParams.get('switch');
      const items = this.switchChanges.filter((item) => !filter || item.switch === filter);
      return json(200, { items, nextCursor: null });
    }
    return false;
  }

  /** The Telegram routes of S05, or false when `path` is not one of them. */
  private async answerTelegram(route: Route, method: string, url: URL): Promise<boolean> {
    const json = async (status: number, value: unknown) => {
      await route.fulfill({ status, json: value });
      return true;
    };
    const apiError = (status: number, code: string) =>
      json(status, { statusCode: status, code, message: code });
    const key = `${method} ${url.pathname}`;
    if (key === 'GET /api/admin/telegram') return json(200, this.telegram);
    if (key === 'POST /api/admin/telegram/link-code') {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      if (!this.telegram.configured) return apiError(409, 'TELEGRAM_NOT_CONFIGURED');
      return json(201, {
        deepLink: 'https://t.me/vertex_digital_bot?start=Kq3v8ZbW1xT0aLmN5pR7sQ',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    if (key === 'DELETE /api/admin/telegram/link') {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      this.telegram = { ...this.telegram, link: null };
      return json(200, this.telegram);
    }
    if (key === 'POST /api/admin/telegram/test') {
      if (!this.telegram.link) return apiError(404, 'NOT_FOUND');
      this.telegram = {
        ...this.telegram,
        lastMessage: {
          kind: 'test',
          status: 'pending',
          createdAt: new Date().toISOString(),
          sentAt: null,
          error: null,
        },
      };
      await route.fulfill({ status: 202 });
      return true;
    }
    return false;
  }

  /** The deposit and rate routes of S03, or false when `path` is not one of them. */
  private async answerDeposits(
    route: Route,
    method: string,
    url: URL,
    body: Record<string, unknown> | null,
  ): Promise<boolean> {
    const path = url.pathname;
    const json = async (status: number, value: unknown) => {
      await route.fulfill({ status, json: value });
      return true;
    };
    const apiError = (status: number, code: string, details?: unknown) =>
      json(status, { statusCode: status, code, message: code, details });
    const image = async () => {
      await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      return true;
    };
    const current = this.rates[0] ?? null;

    if (path === '/api/admin/rates' && method === 'GET') {
      const stale = !current || Date.now() - Date.parse(current.createdAt) > 48 * 3_600_000;
      return json(200, { current, stale, history: { items: this.rates, nextCursor: null } });
    }
    if (path === '/api/admin/rates' && method === 'POST') {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      const input = body as { sypPerUsd: string; rateConfirmation?: string };
      const refusal = rateConfirmationError(current?.sypPerUsd ?? null, input);
      if (refusal) return apiError(400, refusal);
      const record: RateRecord = {
        id: `0199a000-0000-7000-8000-0000000000${(0xf1 + this.rates.length).toString(16)}`,
        sypPerUsd: input.sypPerUsd,
        displayStepSypUnits: Number(body?.displayStepSypUnits),
        changePercent: current ? rateChangePercent(current.sypPerUsd, input.sypPerUsd) : null,
        adminName: this.user.name,
        createdAt: new Date().toISOString(),
      };
      this.rates = [record, ...this.rates];
      return json(201, record);
    }
    if (path === '/api/admin/deposit-settings' && method === 'GET') {
      return json(200, this.depositSettings);
    }
    if (path === '/api/admin/deposit-settings' && method === 'PUT') {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      const savedAt = new Date().toISOString();
      this.depositSettings = { ...body, usdt: this.depositSettings.usdt, saved: true, savedAt };
      return json(200, this.depositSettings);
    }
    if (path === '/api/admin/deposit-settings/qr' && method === 'POST') {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      return json(200, { fileId: crypto.randomUUID() });
    }
    if (QR_PATH.test(path) || RECEIPT_PATH.test(path)) return image();
    if (path === '/api/admin/deposits/counts') {
      const submitted = this.deposits.filter((deposit) => deposit.status === 'submitted');
      return json(200, {
        submitted: submitted.length,
        submittedFlagged: submitted.filter((deposit) => deposit.flags.length > 0).length,
        pending: this.deposits.filter((deposit) => deposit.status === 'pending').length,
        usdtReview: submitted.filter(
          (deposit) => (deposit.usdt as { checkStatus?: string } | null)?.checkStatus === 'review',
        ).length,
        unmatchedTransfers: this.transfersWithState().filter(
          (transfer) => transfer.state === 'unmatched',
        ).length,
      });
    }
    if (path === '/api/admin/deposits' && method === 'GET') {
      const status = url.searchParams.get('status') ?? 'submitted';
      const q = (url.searchParams.get('q') ?? '').toUpperCase();
      const byMethod = url.searchParams.get('method');
      const items = this.deposits
        .filter((deposit) => status === 'all' || deposit.status === status)
        .filter((deposit) => !byMethod || deposit.method === byMethod)
        .filter((deposit) => !q || String(deposit.referenceCode).includes(q))
        // Rule RV10: flagged first, then the oldest submission.
        .sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0))
        .map((deposit) => ({
          ...deposit,
          customer: {
            id: (deposit.customer as { id: string }).id,
            name: (deposit.customer as { name: string }).name,
            email: (deposit.customer as { email: string }).email,
            isTest: (deposit.customer as { isTest: boolean }).isTest,
          },
          flags: [...new Set(deposit.flags.map((flag) => flag.code))],
        }));
      return json(200, { items, nextCursor: null });
    }
    const one = path.match(DEPOSIT_PATH);
    if (one && method === 'GET') {
      const deposit = this.deposits.find((item) => item.id === one[1]);
      return deposit ? json(200, deposit) : apiError(404, 'NOT_FOUND');
    }
    const action = path.match(DEPOSIT_ACTION_PATH);
    if (!action || method !== 'POST') return false;
    const deposit = this.deposits.find((item) => item.id === action[1]);
    if (!deposit) return apiError(404, 'NOT_FOUND');
    const key = route.request().headers()['idempotency-key'];
    if (key && this.decisionKeys.get(key) === JSON.stringify(body)) return json(200, deposit);
    if (deposit.status !== 'submitted') {
      return apiError(409, 'DEPOSIT_STATE_CONFLICT', { status: deposit.status });
    }
    const decided = {
      decidedAt: new Date().toISOString(),
      decidedBy: 'admin',
      adminName: this.user.name,
    };
    if (action[2] === 'recheck') {
      if (!deposit.usdt) return apiError(409, 'DEPOSIT_STATE_CONFLICT', { status: deposit.status });
      return json(202, deposit);
    }
    if (action[2] === 'approve-usdt') {
      // Rule U15: re-authentication always; the credit is the received amount, floored.
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      const usdt = deposit.usdt as {
        txid: string;
        transfer: { amountUnits: number; method: string };
      };
      const expected = [...new Set(deposit.flags.map((flag) => flag.code))];
      const acknowledged = (body?.acknowledgedFlags as string[] | undefined) ?? [];
      if (expected.some((code) => !acknowledged.includes(code))) {
        return apiError(409, 'FLAGS_NOT_ACKNOWLEDGED', { expected });
      }
      const credit = floorToWholeCents(usdt.transfer.amountUnits);
      Object.assign(deposit, decided, {
        status: 'credited',
        eta: null,
        usdt: { ...usdt, checkStatus: 'done' },
        credit: {
          transactionNumber: usdt.txid,
          receivedCurrency: 'USD',
          receivedAmountUnits: usdt.transfer.amountUnits,
          creditedUsdUnits: credit,
          creditRateId: null,
          creditRate: null,
          referenceCheck: null,
          journalId: '0199a000-0000-7000-9000-0000000000c2',
        },
      });
      if (key) this.decisionKeys.set(key, JSON.stringify(body));
      return json(200, deposit);
    }
    if (action[2] === 'approve') {
      const input = body as {
        transactionNumber: string;
        receivedCurrency: 'SYP' | 'USD';
        receivedAmountUnits: number;
        referenceCheck: 'matches' | 'missing' | 'different';
        acknowledgedFlags: string[];
      };
      const atApproval = approvalFlags(deposit, input);
      const expected = [...new Set([...deposit.flags.map((flag) => flag.code), ...atApproval])];
      const rate = input.receivedCurrency === 'SYP' ? (deposit.approvalRate?.rate ?? null) : null;
      const credit = depositCreditUsdUnits(input.receivedCurrency, input.receivedAmountUnits, rate);
      if (approvalNeedsReauthentication(credit, expected.length) && this.reauthenticationRequired) {
        return apiError(403, 'REAUTHENTICATION_REQUIRED');
      }
      const reference = input.transactionNumber.trim().toUpperCase();
      if (this.claimedReferences.has(reference)) {
        return apiError(409, 'EXTERNAL_REFERENCE_TAKEN', {
          kind: 'adjustment',
          id: '0199a000-0000-7000-8000-0000000000b9',
        });
      }
      if (
        expected.length !== input.acknowledgedFlags.length ||
        expected.some((code) => !input.acknowledgedFlags.includes(code))
      ) {
        return apiError(409, 'FLAGS_NOT_ACKNOWLEDGED', { expected });
      }
      this.claimedReferences.add(reference);
      Object.assign(deposit, decided, {
        status: 'credited',
        eta: null,
        flags: [
          ...deposit.flags,
          ...atApproval.map((code, index) => ({
            id: `0199a000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
            code,
            receiptId: null,
            details: {},
            createdAt: decided.decidedAt,
          })),
        ],
        credit: {
          transactionNumber: input.transactionNumber.trim(),
          receivedCurrency: input.receivedCurrency,
          receivedAmountUnits: input.receivedAmountUnits,
          creditedUsdUnits: credit,
          creditRateId: rate ? (deposit.approvalRate?.rateId ?? null) : null,
          creditRate: rate,
          referenceCheck: input.referenceCheck,
          journalId: '0199a000-0000-7000-9000-0000000000c1',
        },
      });
    } else if (action[2] === 'reject') {
      Object.assign(deposit, decided, {
        status: 'rejected',
        eta: null,
        rejection: { reason: body?.reason, customerNote: body?.customerNote ?? null },
      });
    } else {
      if (deposit.receiptRequestCount > 0) return apiError(409, 'RECEIPT_ALREADY_REQUESTED');
      Object.assign(deposit, {
        status: 'pending',
        eta: null,
        receiptRequestCount: 1,
        receiptRequestedAt: new Date().toISOString(),
        receiptRequestNote: body?.customerNote ?? null,
      });
    }
    if (key) this.decisionKeys.set(key, JSON.stringify(body));
    return json(200, deposit);
  }

  /**
   * The transfers with their state derived as the API does (rule U13): credited when an
   * adjustment or a credited deposit holds the TXID, bound when a deposit holds it, else unmatched.
   */
  transfersWithState() {
    return this.usdtTransfers.map((transfer) => {
      const adjustment = this.adjustments.find(
        (item) =>
          item.depositMethod === transfer.method &&
          item.externalReference?.toLowerCase() === transfer.txid,
      );
      const deposit = this.deposits.find(
        (item) => (item.usdt as { txid?: string } | null)?.txid === transfer.txid,
      );
      const customer = (deposit?.customer ?? WALLET_CUSTOMER) as typeof WALLET_CUSTOMER;
      const holder = adjustment
        ? { kind: 'adjustment', id: adjustment.id, customer: WALLET_CUSTOMER }
        : deposit
          ? { kind: 'deposit', id: deposit.id, customer }
          : null;
      const state =
        adjustment || deposit?.status === 'credited' ? 'credited' : deposit ? 'bound' : 'unmatched';
      return {
        ...transfer,
        state,
        holder: holder && {
          ...holder,
          customer: { id: customer.id, name: customer.name, email: customer.email },
        },
        candidates: state === 'unmatched' ? transfer.candidates : [],
      };
    });
  }

  /** The body of the last request to `key`. */
  lastBody(key: string): unknown {
    return this.bodies.findLast((entry) => entry.key === key)?.body;
  }

  async answer(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const key = `${request.method()} ${path}`;
    this.calls.push(key);
    const body = jsonBody(request);
    this.bodies.push({ key, body });
    this.requests.push({ key, headers: request.headers() });
    const json = (status: number, value: unknown) => route.fulfill({ status, json: value });
    const apiError = (status: number, code: string) =>
      json(status, { statusCode: status, code, message: code });

    if (
      this.idleExpired &&
      path.startsWith('/api/admin/') &&
      !path.startsWith('/api/admin/auth/')
    ) {
      this.idleExpired = false;
      this.signedIn = false;
      return apiError(401, 'SESSION_IDLE_EXPIRED');
    }
    if (request.method() === 'POST' && RESET_PASSWORD_PATH.test(path)) {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      return json(200, { password: GENERATED_PASSWORD });
    }
    const walletPath = path.match(WALLET_PATH);
    if (request.method() === 'GET' && walletPath) {
      if (walletPath[1] !== CUSTOMER_ID) return apiError(404, 'NOT_FOUND');
      return json(200, {
        customer: WALLET_CUSTOMER,
        balanceUnits: this.balanceUnits,
        syp: null,
        adjustmentCount: this.adjustments.length,
      });
    }
    if (request.method() === 'GET' && WALLET_ENTRIES_PATH.test(path)) {
      return json(200, { items: this.walletEntries(), nextCursor: null });
    }
    const adjustmentsPath = path.match(ADJUSTMENTS_PATH);
    const reversePath = path.match(REVERSE_PATH);
    if (request.method() === 'POST' && (adjustmentsPath || reversePath)) {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      const key = request.headers()['idempotency-key'];
      let result: ReturnType<AdminApi['adjust']>;
      if (reversePath) {
        const original = this.adjustments.find((item) => item.id === reversePath[1]);
        if (!original) return apiError(404, 'NOT_FOUND');
        if (original.reversesAdjustmentId) return apiError(409, 'ADJUSTMENT_NOT_REVERSIBLE');
        const replay = key ? this.adjustmentKeys.get(key) : undefined;
        if (!replay && this.adjustments.some((item) => item.reversesAdjustmentId === original.id)) {
          return apiError(409, 'ADJUSTMENT_ALREADY_REVERSED');
        }
        result = this.adjust(
          key,
          {
            direction: original.direction === 'credit' ? 'debit' : 'credit',
            amountUnits: original.amountUnits,
            category: original.category,
            reason: String(body?.reason),
            customerNote: (body?.customerNote as string | undefined) ?? null,
            depositMethod: null,
            externalReference: null,
            reversesAdjustmentId: original.id,
          },
          body?.amountConfirmationUnits,
        );
      } else {
        result = this.adjust(
          key,
          {
            direction: body?.direction as Adjustment['direction'],
            amountUnits: Number(body?.amountUnits),
            category: String(body?.category),
            reason: String(body?.reason),
            customerNote: (body?.customerNote as string | undefined) ?? null,
            depositMethod: (body?.depositMethod as string | undefined) ?? null,
            externalReference: (body?.externalReference as string | undefined) ?? null,
            reversesAdjustmentId: null,
          },
          body?.amountConfirmationUnits,
        );
      }
      if ('code' in result) {
        const details =
          'balanceUnits' in result ? { balanceUnits: result.balanceUnits } : undefined;
        return json(result.status, {
          statusCode: result.status,
          code: result.code,
          message: result.code,
          details,
        });
      }
      return json(result.status, {
        ...result.adjustment,
        customerId: CUSTOMER_ID,
        journalId: result.adjustment.id,
      });
    }
    if (key === 'GET /api/admin/usdt-transfers') {
      const state = url.searchParams.get('state') ?? 'unmatched';
      const byMethod = url.searchParams.get('method');
      const items = this.transfersWithState()
        .filter((transfer) => state === 'all' || transfer.state === 'unmatched')
        .filter((transfer) => !byMethod || transfer.method === byMethod);
      return json(200, { items, nextCursor: null });
    }
    if (path.startsWith('/api/admin/switches')) {
      const answered = await this.answerSwitches(route, request.method(), url, body);
      if (answered) return;
    }
    if (path.startsWith('/api/admin/telegram')) {
      const answered = await this.answerTelegram(route, request.method(), url);
      if (answered) return;
    }
    if (path.startsWith('/api/admin/deposit') || path === '/api/admin/rates') {
      const answered = await this.answerDeposits(route, request.method(), url, body);
      if (answered) return;
    }
    const ownSession = path.match(OWN_SESSION_PATH);
    if (request.method() === 'DELETE' && ownSession) {
      this.sessions = this.sessions.filter((session) => session.id !== ownSession[1]);
      return route.fulfill({ status: 204 });
    }

    switch (key) {
      case 'GET /api/admin/auth/get-session':
        return json(200, this.signedIn ? { session: { id: 's' }, user: this.user } : null);
      case 'POST /api/admin/auth/sign-in/email': {
        if (this.altchaRequired && !request.headers()['x-altcha']) {
          return json(400, { code: 'ALTCHA_REQUIRED', message: 'Solve the challenge first' });
        }
        if (body?.password !== PASSWORD) {
          return json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid' });
        }
        if (this.user.twoFactorEnabled) {
          this.pendingTwoFactor = true;
          return json(200, { twoFactorRedirect: true });
        }
        this.signedIn = true;
        return json(200, { redirect: false, token: 't', user: this.user });
      }
      case 'POST /api/admin/auth/two-factor/verify-totp':
        if (body?.code !== TOTP_CODE) return json(401, { code: 'INVALID_CODE', message: 'x' });
        // At sign-in it opens the session; during enrolment it turns TOTP on.
        if (this.pendingTwoFactor) this.signedIn = true;
        this.pendingTwoFactor = false;
        this.user = { ...this.user, twoFactorEnabled: true };
        return json(200, { token: 't', user: this.user });
      case 'POST /api/admin/auth/two-factor/verify-backup-code':
        if (body?.code !== BACKUP_CODE) {
          return json(401, { code: 'INVALID_BACKUP_CODE', message: 'x' });
        }
        this.signedIn = true;
        return json(200, { token: 't', user: this.user });
      case 'POST /api/admin/auth/two-factor/enable':
        if (body?.password !== PASSWORD)
          return json(400, { code: 'INVALID_PASSWORD', message: 'x' });
        return json(200, {
          totpURI:
            'otpauth://totp/Vertex%20Digital:reem?secret=JBSWY3DPEHPK3PXP&issuer=Vertex%20Digital',
          backupCodes: [BACKUP_CODE, 'bcdef-ghjkm'],
        });
      case 'POST /api/admin/auth/two-factor/generate-backup-codes':
        if (body?.password !== PASSWORD) {
          return json(400, { code: 'INVALID_PASSWORD', message: 'x' });
        }
        return json(200, { status: true, backupCodes: ['hjkmn-pqrst', 'uvwxy-z2345'] });
      case 'POST /api/admin/auth/change-password':
        if (body?.currentPassword !== PASSWORD) return apiError(400, 'INVALID_PASSWORD');
        this.user = { ...this.user, mustChangePassword: false };
        return json(200, { success: true });
      case 'POST /api/admin/auth/sign-out':
        this.signedIn = false;
        return json(200, { success: true });
      case 'POST /api/admin/me/reauthenticate':
        if (body?.password !== PASSWORD) return apiError(400, 'INVALID_PASSWORD');
        if (body?.totpCode !== TOTP_CODE) return apiError(400, 'INVALID_CODE');
        this.reauthenticationRequired = false;
        return json(200, { reauthenticatedUntil: '2026-10-08T10:05:00.000Z' });
      case 'GET /api/admin/me/sessions':
        return json(200, this.sessions);
      case 'GET /api/admin/audit': {
        const filter = (name: string, value: string | null) => {
          const wanted = url.searchParams.get(name);
          return !wanted || wanted === value;
        };
        const matching = this.auditEntries.filter(
          (entry) =>
            filter('actorKind', entry.actorKind) &&
            filter('actorId', entry.actorId) &&
            filter('action', entry.action) &&
            filter('entityType', entry.entityType) &&
            filter('entityId', entry.entityId),
        );
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const end = start + AUDIT_PAGE_SIZE;
        return json(200, {
          items: matching.slice(start, end),
          nextCursor: end < matching.length ? String(end) : null,
        });
      }
      case 'GET /api/admin/ledger/summary': {
        const owed = this.balanceUnits;
        return json(200, {
          owedToCustomersUnits: 0,
          owedToTestCustomersUnits: owed,
          walletsWithBalance: owed > 0 ? 1 : 0,
          systemAccounts: [...new Set(this.adjustments.map((item) => item.category))].map(
            (category) => ({
              kind: 'adjustments',
              code: `adjustments:${category}`,
              currency: 'USD',
              balanceUnits: -this.adjustments
                .filter((item) => item.category === category)
                .reduce(
                  (sum, item) =>
                    sum + (item.direction === 'credit' ? item.amountUnits : -item.amountUnits),
                  0,
                ),
            }),
          ),
        });
      }
      case 'GET /api/admin/wallets': {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const { name, email, phone } = WALLET_CUSTOMER;
        const found =
          name.includes(q) ||
          email.startsWith(q) ||
          phone.replace('+', '').startsWith(q.replace('+', ''));
        return json(200, {
          items: found ? [{ ...WALLET_CUSTOMER, balanceUnits: this.balanceUnits }] : [],
          nextCursor: null,
        });
      }
      case 'GET /api/admin/test-customers':
        return json(200, { items: this.testCustomers, nextCursor: null });
      case 'POST /api/admin/test-customers': {
        if (this.testCustomers.some((customer) => customer.email === body?.email)) {
          return apiError(409, 'EMAIL_TAKEN');
        }
        const customer = {
          id: CUSTOMER_ID,
          name: String(body?.name),
          email: String(body?.email),
          phone: String(body?.phone),
          createdAt: '2026-10-08T09:00:00.000Z',
        };
        this.testCustomers = [customer, ...this.testCustomers];
        return json(201, { ...customer, password: GENERATED_PASSWORD });
      }
      case 'GET /api/altcha/challenge':
        // A real challenge needs the API's key; the mock only checks that one is fetched and sent.
        return json(200, {
          parameters: {
            algorithm: 'PBKDF2/SHA-256',
            nonce: 'aa',
            salt: 'bb',
            cost: 1,
            keyLength: 32,
            keyPrefix: '0',
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
          signature: 'test',
        });
    }
    const isDeclared =
      path.startsWith('/api/admin/auth/') ||
      declared.some((route) => route.pattern.test(path) && route.methods.has(request.method()));
    this.unexpected.push(isDeclared ? key : `${key} (not in openapi.json)`);
    return json(404, { statusCode: 404, code: 'NOT_FOUND', message: 'Not mocked' });
  }
}

/** A JSON body as sent, or null (a multipart upload, a GET). */
function jsonBody(request: ReturnType<Route['request']>): Record<string, unknown> | null {
  try {
    return request.postDataJSON() as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export const test = base.extend<{ admin: AdminApi }>({
  admin: async ({ page }, use) => {
    const admin = new AdminApi();
    await page.route('**/api/**', (route) => admin.answer(route));
    await use(admin);
    expect(admin.unexpected, 'API requests without a mock').toEqual([]);
  },
  page: async ({ page }, use) => {
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(`Page error: ${error.message}`));
    page.on('console', (message) => {
      // Mocked HTTP errors are logged by the browser; they are the behaviour under test.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        failures.push(`Console: ${message.text()}`);
      }
    });
    await use(page);
    expect(failures).toEqual([]);
  },
});

/** A screenshot attached to the report: the RTL review evidence of each run. */
export async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  { fullPage = false }: { fullPage?: boolean } = {},
): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // A full page is captured from the top, so the sticky bar and navigation sit where they belong.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

export { expect };
