import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  DEPOSIT_SETTINGS_DEFAULTS,
  REFERENCE_CODE_ALPHABET,
  REFERENCE_CODE_LENGTH,
  REFERENCE_CODE_PREFIX,
  USDT_NETWORKS,
} from '@vertex-digital/contracts';
import {
  depositFlags,
  deposits,
  ledgerAccounts,
  ledgerJournals,
  ledgerPostings,
  newId,
  paymentReferences,
  telegramLinks,
  telegramMessages,
  usdtDeposits,
  usdtScanCursors,
  usdtTransfers,
} from '@vertex-digital/db';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  body,
  emailsTo,
  notificationsOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
  uniquePhone,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * USDT deposits (S04, F06) over HTTP against the test database. Only the TRON address is
 * configured, so BSC answers `not_configured`. There is no worker here: the transfers a
 * verification or a scan would record are written straight into the database. Deposit settings
 * are global: this file saves its own, with limits high enough that random amounts never meet
 * the tails earlier runs left reserved.
 */

const USD = 1_000_000;
const TRON_ADDRESS = USDT_NETWORKS.usdt_trc20.contract;

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
/** An admin session without a recent re-authentication. */
let plainAdmin: string;
const seeded: string[] = [];

const txid = () => randomBytes(32).toString('hex');
/** A random whole-cent amount from $5 to $9,000: tails of earlier runs never collide. */
const amount = () => randomInt(500, 900_000) * 10_000;

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

async function customer() {
  const seededCustomer = await seedCustomer(test.db, { phone: uniquePhone() });
  seeded.push(seededCustomer.id);
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

type Customer = Awaited<ReturnType<typeof customer>>;

interface UsdtView {
  method: string;
  address: string;
  payAmount: string;
  payAmountUnits: number;
  checkStatus: string;
  checkError: string | null;
  txid: string | null;
  receivedAmountUnits: number | null;
  reviewReasons: string[];
}

type DepositView = Record<string, unknown> & { id: string; status: string; usdt: UsdtView };

const create = async (
  cookie: string,
  input: { method?: string; amountUnits: number },
  key: string = randomUUID(),
) =>
  client.post('/api/deposits/usdt', {
    cookie,
    body: { method: 'usdt_trc20', ...input },
    headers: { 'idempotency-key': key, ...(await client.altcha()) },
  });

async function created(cookie: string, amountUnits = amount()): Promise<DepositView> {
  const response = await create(cookie, { amountUnits });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as DepositView;
}

const submitTxid = (cookie: string, id: string, value: string) =>
  client.post(`/api/deposits/${id}/txid`, { cookie, body: { txid: value } });

/** Records a transfer, as the scanner or the verifier would. */
async function transfer(
  values: Partial<typeof usdtTransfers.$inferInsert> & { amountUnits: number },
) {
  const [row] = await test.db
    .insert(usdtTransfers)
    .values({
      id: newId(),
      txid: txid(),
      fromAddress: 'TSenderAddressxxxxxxxxxxxxxxxxxxxx',
      toAddress: TRON_ADDRESS,
      rawAmount: String(values.amountUnits),
      blockNumber: 1_000,
      blockTime: new Date(),
      source: 'txid',
      ...values,
      method: values.method ?? 'usdt_trc20',
    })
    .returning();
  if (!row) throw new Error('No transfer');
  return row;
}

/**
 * A deposit in review, as the verifier leaves one (rule U11): its TXID found, the transfer bound,
 * and the review flag raised. `received` defaults to $1 less than the amount to pay.
 */
async function inReview(
  someone: Customer,
  options: { received?: (pay: number) => number; method?: 'usdt_trc20' | 'usdt_bep20' } = {},
) {
  const deposit = await created(someone.cookie);
  const pay = deposit.usdt.payAmountUnits;
  const received = (options.received ?? ((value) => value - USD))(pay);
  const bound = await transfer({ amountUnits: received, method: options.method });
  const flag = options.method === 'usdt_bep20' ? 'wrong_network' : 'amount_mismatch';
  await test.db.transaction(async (tx) => {
    await tx
      .update(usdtDeposits)
      .set({
        txid: bound.txid,
        txidSource: 'customer',
        txidSubmissions: 1,
        searchStartedAt: sql`now()`,
        checkStatus: 'review',
        transferId: bound.id,
      })
      .where(eq(usdtDeposits.depositId, deposit.id));
    await tx
      .update(deposits)
      .set({ status: 'submitted', submittedAt: sql`now()` })
      .where(eq(deposits.id, deposit.id));
    await tx.insert(depositFlags).values({
      id: newId(),
      depositId: deposit.id,
      code: flag,
      details:
        flag === 'wrong_network'
          ? { depositMethod: 'usdt_trc20', transferMethod: 'usdt_bep20' }
          : {
              declaredCurrency: 'USD',
              declaredAmountUnits: pay,
              receivedCurrency: 'USD',
              receivedAmountUnits: received,
            },
    });
  });
  return { deposit, transfer: bound, received, flag };
}

const approveUsdt = (
  id: string,
  input: Record<string, unknown>,
  options: { cookie?: string; key?: string } = {},
) =>
  client.post(`/api/admin/deposits/${id}/approve-usdt`, {
    cookie: options.cookie ?? admin.cookie,
    body: input,
    headers: { 'idempotency-key': options.key ?? randomUUID() },
  });

const adminDeposit = async (id: string) =>
  (await (
    await client.get(`/api/admin/deposits/${id}`, { cookie: admin.cookie })
  ).json()) as Record<string, unknown> & {
    status: string;
    decidedBy: string | null;
    usdt: UsdtView & {
      tailUnits: number;
      transfer: { id: string; amountUnits: number } | null;
      candidates: { depositId: string }[];
    };
  };

const postingsOf = (depositId: string) =>
  test.db
    .select({ code: ledgerAccounts.code, amountUnits: ledgerPostings.amountUnits })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerPostings.accountId))
    .where(eq(ledgerJournals.idempotencyKey, `deposit:${depositId}`))
    .orderBy(ledgerPostings.position);

const verifyJobs = async (depositId: string) =>
  (
    await test.db.execute<{ count: number }>(
      sql`select count(*)::int as count from pgboss.job
        where name = 'deposits.usdt-verify' and data->>'depositId' = ${depositId}`,
    )
  ).rows[0]?.count ?? 0;

const actionsOf = async (depositId: string) =>
  (await auditOf(test.db, depositId)).map((entry) => entry.action);

async function scannedNow(method: 'usdt_trc20' | 'usdt_bep20', ago = '0 minutes') {
  await test.db
    .insert(usdtScanCursors)
    .values({ method, cursor: '0', lastSuccessAt: sql`now() - ${ago}::interval` })
    .onConflictDoUpdate({
      target: usdtScanCursors.method,
      set: { lastSuccessAt: sql`now() - ${ago}::interval` },
    });
}

const settingsInput = {
  ...DEPOSIT_SETTINGS_DEFAULTS,
  shamCashAccountName: 'Vertex Digital',
  shamCashAccountNumber: '0933000000',
  newAccountPerDepositUsdUnits: 10_000 * USD,
  newAccountDailyUsdUnits: 1_000_000 * USD,
  establishedPerDepositUsdUnits: 10_000 * USD,
  establishedDailyUsdUnits: 1_000_000 * USD,
  usdtTrc20Enabled: true,
};

async function saveSettings(input: Record<string, unknown>) {
  return client.request('PUT', '/api/admin/deposit-settings', {
    cookie: admin.cookie,
    body: input,
  });
}

/**
 * A reference code no deposit holds, from the API's alphabet. Test rows stay in the database, so
 * a code drawn at random must be checked against them.
 */
async function freeReferenceCode(): Promise<string> {
  for (;;) {
    const code = `${REFERENCE_CODE_PREFIX}${Array.from(
      { length: REFERENCE_CODE_LENGTH },
      () => REFERENCE_CODE_ALPHABET[randomInt(REFERENCE_CODE_ALPHABET.length)],
    ).join('')}`;
    const [taken] = await test.db
      .select({ id: deposits.id })
      .from(deposits)
      .where(eq(deposits.referenceCode, code));
    if (!taken) return code;
  }
}

beforeAll(async () => {
  process.env.USDT_TRC20_ADDRESS = TRON_ADDRESS;
  delete process.env.USDT_BEP20_ADDRESS;
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  await reauthenticate();
  expect((await saveSettings(settingsInput)).status).toBe(200);
  await scannedNow('usdt_trc20');
});

afterAll(async () => {
  await test.db
    .update(telegramLinks)
    .set({ unlinkedAt: new Date() })
    .where(isNull(telegramLinks.unlinkedAt));
  delete process.env.USDT_TRC20_ADDRESS;
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S04)', () => {
  it('answers 401 without a session, and keeps customer and admin routes apart', async () => {
    const someone = await customer();
    const id = randomUUID();
    const customerRoutes = [
      ['GET', '/api/deposits/usdt/options'],
      ['POST', '/api/deposits/usdt'],
      ['POST', `/api/deposits/${id}/txid`],
    ] as const;
    const adminRoutes = [
      ['POST', `/api/admin/deposits/${id}/approve-usdt`],
      ['POST', `/api/admin/deposits/${id}/recheck`],
      ['GET', '/api/admin/usdt-transfers'],
    ] as const;
    const send = (method: string, path: string, cookie?: string) =>
      client.request(method, path, { cookie, ...(method === 'POST' && { body: {} }) });
    for (const [method, path] of [...customerRoutes, ...adminRoutes]) {
      expect((await send(method, path)).status, path).toBe(401);
    }
    for (const [method, path] of adminRoutes) {
      expect((await send(method, path, someone.cookie)).status, path).toBe(401);
    }
    for (const [method, path] of customerRoutes) {
      expect((await send(method, path, admin.cookie)).status, path).toBe(401);
    }
  });

  it('never caches USDT answers (rule U18)', async () => {
    const someone = await customer();
    const options = await client.get('/api/deposits/usdt/options', { cookie: someone.cookie });
    expect(options.headers.get('cache-control')).toBe('no-store');
    const deposit = await create(someone.cookie, { amountUnits: amount() });
    expect(deposit.headers.get('cache-control')).toBe('no-store');
    const transfers = await client.get('/api/admin/usdt-transfers', { cookie: admin.cookie });
    expect(transfers.headers.get('cache-control')).toBe('no-store');
  });
});

describe('USDT settings (rule U1)', () => {
  it('shows the server addresses read-only, with the scanners, and refuses a switch without one', async () => {
    const settings = (await (
      await client.get('/api/admin/deposit-settings', { cookie: admin.cookie })
    ).json()) as { usdtTrc20Enabled: boolean; usdt: unknown[] };
    expect(settings.usdtTrc20Enabled).toBe(true);
    expect(settings.usdt).toEqual([
      {
        method: 'usdt_trc20',
        address: TRON_ADDRESS,
        lastScanAt: expect.any(String),
        delayed: false,
      },
      expect.objectContaining({ method: 'usdt_bep20', address: null }),
    ]);
    expect(
      await body(await saveSettings({ ...settingsInput, usdtBep20Enabled: true })),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: [{ path: ['usdtBep20Enabled'] }],
    });
    // Above the lowest per-deposit limit: refused by the contract.
    expect(
      await body(await saveSettings({ ...settingsInput, usdtMinDepositUsdUnits: 20_000 * USD })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('the USDT options (rules U1, U5)', () => {
  it('lists each network with its reason, and the limits with the USDT minimum', async () => {
    const someone = await customer();
    const options = (await (
      await client.get('/api/deposits/usdt/options', { cookie: someone.cookie })
    ).json()) as Record<string, unknown>;
    expect(options).toEqual({
      networks: [
        {
          method: 'usdt_trc20',
          state: 'available',
          available: true,
          unavailableReason: null,
          address: TRON_ADDRESS,
          confirmations: 19,
        },
        {
          method: 'usdt_bep20',
          state: 'unavailable',
          available: false,
          unavailableReason: 'not_configured',
          address: null,
          confirmations: 15,
        },
      ],
      limits: expect.objectContaining({ minUnits: 5 * USD, perDepositUnits: 10_000 * USD }),
      pendingDepositId: null,
    });
    const deposit = await created(someone.cookie);
    const again = (await (
      await client.get('/api/deposits/usdt/options', { cookie: someone.cookie })
    ).json()) as { pendingDepositId: string };
    expect(again.pendingDepositId).toBe(deposit.id);
  });

  it('shows a network paused or stopped, and refuses its new deposits (S05 rules SW4, SW6)', async () => {
    const someone = await customer();
    const states = async () =>
      (
        (await (
          await client.get('/api/deposits/usdt/options', { cookie: someone.cookie })
        ).json()) as { networks: { method: string; state: string; available: boolean }[] }
      ).networks.map((network) => [network.method, network.state, network.available]);
    try {
      await setSwitches(test.db, { usdt_trc20_paused: true });
      expect(await states()).toEqual([
        ['usdt_trc20', 'paused', true],
        ['usdt_bep20', 'unavailable', false],
      ]);
      expect(await body(await create(someone.cookie, { amountUnits: amount() }))).toMatchObject({
        status: 409,
        code: 'DEPOSITS_STOPPED',
        details: { reason: 'method_paused' },
      });
      await setSwitches(test.db, { deposits_stopped: true });
      expect(await states()).toEqual([
        ['usdt_trc20', 'stopped', true],
        ['usdt_bep20', 'stopped', false],
      ]);
      expect(await body(await create(someone.cookie, { amountUnits: amount() }))).toMatchObject({
        status: 409,
        code: 'DEPOSITS_STOPPED',
        details: { reason: 'emergency' },
      });
      await setSwitches(test.db, { sham_cash_paused: true, usdt_bep20_paused: true });
      expect((await create(someone.cookie, { amountUnits: amount() })).status).toBe(201);
    } finally {
      await setSwitches(test.db);
    }
  });

  it('marks a network delayed when its scanner is late, and refuses new deposits (rule U12)', async () => {
    const someone = await customer();
    await scannedNow('usdt_trc20', '11 minutes');
    try {
      const options = (await (
        await client.get('/api/deposits/usdt/options', { cookie: someone.cookie })
      ).json()) as { networks: { unavailableReason: string | null }[] };
      expect(options.networks[0]?.unavailableReason).toBe('delayed');
      expect(await body(await create(someone.cookie, { amountUnits: amount() }))).toMatchObject({
        status: 409,
        code: 'DEPOSIT_METHOD_UNAVAILABLE',
        details: { method: 'usdt_trc20', reason: 'delayed' },
      });
    } finally {
      await scannedNow('usdt_trc20');
    }
  });

  it('refuses a disabled or unconfigured network', async () => {
    const someone = await customer();
    expect(
      await body(await create(someone.cookie, { method: 'usdt_bep20', amountUnits: amount() })),
    ).toMatchObject({ status: 409, details: { reason: 'not_configured' } });
    expect((await saveSettings({ ...settingsInput, usdtTrc20Enabled: false })).status).toBe(200);
    try {
      expect(await body(await create(someone.cookie, { amountUnits: amount() }))).toMatchObject({
        status: 409,
        code: 'DEPOSIT_METHOD_UNAVAILABLE',
        details: { reason: 'disabled' },
      });
    } finally {
      expect((await saveSettings(settingsInput)).status).toBe(200);
    }
  });
});

describe('creating a USDT deposit (rules U2–U5)', () => {
  it('asks for the exact amount with a tail, to the configured address, and audits it', async () => {
    const someone = await customer();
    const declared = amount();
    const deposit = await created(someone.cookie, declared);
    const tail = deposit.usdt.payAmountUnits - declared;
    expect(tail).toBeGreaterThanOrEqual(100);
    expect(tail).toBeLessThanOrEqual(9_900);
    expect(tail % 100).toBe(0);
    expect(deposit).toMatchObject({
      method: 'usdt_trc20',
      status: 'pending',
      currency: 'USD',
      declaredAmountUnits: declared,
      declaredUsdUnits: declared,
      quote: null,
      payTo: null,
      usdt: {
        method: 'usdt_trc20',
        address: TRON_ADDRESS,
        payAmount: `${Math.floor(declared / USD)}.${String(((declared % USD) + tail) / 100).padStart(4, '0')}`,
        checkStatus: 'awaiting_transfer',
        checkError: null,
        txid: null,
        requiredConfirmations: 19,
        delayed: false,
      },
    });
    const [entry] = await auditOf(test.db, deposit.id);
    expect(entry).toMatchObject({
      action: 'deposit.created',
      details: expect.objectContaining({ rateId: null, payAmountUnits: declared + tail }),
    });
    // The network's scan is sent with it (rule U12), or one was already queued (one per network).
    const scans = await test.db.execute<{ count: number }>(
      sql`select count(*)::int as count from pgboss.job
        where name = 'deposits.usdt-scan' and singleton_key = 'usdt_trc20'
          and (state in ('created', 'retry', 'active') or created_on >= ${deposit.createdAt}::timestamptz)`,
    );
    expect(scans.rows[0]?.count).toBeGreaterThanOrEqual(1);
  });

  it('replays the same key and body, refuses the key with another body, and creates once in parallel', async () => {
    const someone = await customer();
    const key = randomUUID();
    const declared = amount();
    const [first, second] = await Promise.all([
      create(someone.cookie, { amountUnits: declared }, key),
      create(someone.cookie, { amountUnits: declared }, key),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as DepositView[];
    expect(a?.id).toBe(b?.id);
    expect(
      await body(await create(someone.cookie, { amountUnits: declared + 10_000 }, key)),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('keeps one pending deposit across methods, and the USDT minimum', async () => {
    const someone = await customer();
    expect(await body(await create(someone.cookie, { amountUnits: 4_990_000 }))).toMatchObject({
      status: 422,
      code: 'DEPOSIT_LIMIT_EXCEEDED',
      details: { limit: 'minimum', limitUnits: 5 * USD },
    });
    const first = await created(someone.cookie);
    expect(await body(await create(someone.cookie, { amountUnits: amount() }))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_ALREADY_PENDING',
      details: { depositId: first.id },
    });
  });

  it('refuses a fraction of a cent, Sham Cash as a USDT method, and no ALTCHA', async () => {
    const someone = await customer();
    for (const input of [
      { amountUnits: 5 * USD + 100 },
      { method: 'sham_cash', amountUnits: 5 * USD },
    ]) {
      expect(await body(await create(someone.cookie, input))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
    const noAltcha = await client.post('/api/deposits/usdt', {
      cookie: someone.cookie,
      body: { method: 'usdt_trc20', amountUnits: 5 * USD },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(await body(noAltcha)).toMatchObject({ status: 400, code: 'ALTCHA_REQUIRED' });
  });

  it('gives parallel deposits of one amount different tails, and refuses when all 99 are taken', async () => {
    const declared = amount();
    const people = await Promise.all([customer(), customer(), customer(), customer()]);
    const made = await Promise.all(people.map(async (person) => created(person.cookie, declared)));
    const pays = new Set(made.map((deposit) => deposit.usdt.payAmountUnits));
    expect(pays.size).toBe(4);
    // The other 95 tails, reserved by deposits written straight in.
    const holder = await customer();
    for (let tail = 100; tail <= 9_900; tail += 100) {
      if (pays.has(declared + tail)) continue;
      const depositId = newId();
      await test.db.transaction(async (tx) => {
        await tx.insert(deposits).values({
          id: depositId,
          customerId: holder.id,
          method: 'usdt_trc20',
          status: 'submitted',
          submittedAt: new Date(),
          referenceCode: await freeReferenceCode(),
          currency: 'USD',
          declaredAmountUnits: declared,
          declaredUsdUnits: declared,
          expiresAt: sql`now() + interval '1 day'`,
          idempotencyKey: randomUUID(),
        });
        await tx.insert(usdtDeposits).values({
          depositId,
          method: 'usdt_trc20',
          receivingAddress: TRON_ADDRESS,
          tailUnits: tail,
          payAmountUnits: declared + tail,
          checkStatus: 'searching',
          txid: txid(),
          txidSource: 'customer',
        });
      });
    }
    const last = await customer();
    expect(await body(await create(last.cookie, { amountUnits: declared }))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_AMOUNT_BUSY',
    });
    // A cent more is free.
    expect((await create(last.cookie, { amountUnits: declared + 10_000 })).status).toBe(201);
  });
});

describe('submitting a TXID (rule U8)', () => {
  it('normalizes a link, starts the verification and audits it', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie);
    const hash = txid();
    const response = await submitTxid(
      someone.cookie,
      deposit.id,
      `https://tronscan.org/#/transaction/${hash.toUpperCase()}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      status: 'submitted',
      usdt: {
        checkStatus: 'searching',
        txid: hash,
        explorerUrl: `https://tronscan.org/#/transaction/${hash}`,
      },
    });
    expect(await verifyJobs(deposit.id)).toBe(1);
    expect(await actionsOf(deposit.id)).toEqual(['deposit.created', 'deposit.txid_submitted']);
    // Submitted already: a second TXID waits for the verification.
    expect(await body(await submitTxid(someone.cookie, deposit.id, txid()))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
    });
  });

  it('refuses garbage, a sixth TXID, and a deposit past its expiry', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie);
    expect(await body(await submitTxid(someone.cookie, deposit.id, 'not a hash'))).toMatchObject({
      status: 400,
      code: 'TXID_INVALID',
    });
    await test.db
      .update(usdtDeposits)
      .set({ txidSubmissions: 5 })
      .where(eq(usdtDeposits.depositId, deposit.id));
    expect(await body(await submitTxid(someone.cookie, deposit.id, txid()))).toMatchObject({
      status: 409,
      code: 'TXID_ATTEMPTS_EXCEEDED',
    });
    const other = await customer();
    const late = await created(other.cookie);
    await test.db
      .update(deposits)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(deposits.id, late.id));
    expect(await body(await submitTxid(other.cookie, late.id, txid()))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
      details: { status: 'expired' },
    });
  });

  it('refuses a TXID claimed already or held by another deposit, without naming it', async () => {
    const first = await customer();
    const second = await customer();
    const a = await created(first.cookie);
    const b = await created(second.cookie);
    const hash = txid();
    expect((await submitTxid(first.cookie, a.id, hash)).status).toBe(200);
    const taken = await body(await submitTxid(second.cookie, b.id, `0x${hash}`));
    expect(taken).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_TAKEN' });
    expect(taken.details).toBeUndefined();
    const claimed = txid();
    await test.db.insert(paymentReferences).values({
      id: newId(),
      method: 'usdt_bep20',
      reference: claimed.toUpperCase(),
      depositId: a.id,
    });
    expect(await body(await submitTxid(second.cookie, b.id, claimed))).toMatchObject({
      code: 'EXTERNAL_REFERENCE_TAKEN',
    });
  });

  it('allows 20 TXID submissions an hour per customer, refused ones included', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await submitTxid(someone.cookie, deposit.id, 'garbage')).status).toBe(400);
    }
    expect(await body(await submitTxid(someone.cookie, deposit.id, txid()))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });
});

describe('the customer reads only their own USDT deposits', () => {
  it('answers 404 for another customer, and lists and cancels their own', async () => {
    const owner = await customer();
    const stranger = await customer();
    const deposit = await created(owner.cookie);
    for (const response of [
      await client.get(`/api/deposits/${deposit.id}`, { cookie: stranger.cookie }),
      await submitTxid(stranger.cookie, deposit.id, txid()),
      await client.post(`/api/deposits/${deposit.id}/cancel`, { cookie: stranger.cookie }),
    ]) {
      expect(response.status).toBe(404);
    }
    const page = (await (await client.get('/api/deposits', { cookie: owner.cookie })).json()) as {
      items: DepositView[];
    };
    expect(page.items[0]).toMatchObject({ id: deposit.id, usdt: { method: 'usdt_trc20' } });
    const cancelled = await client.post(`/api/deposits/${deposit.id}/cancel`, {
      cookie: owner.cookie,
    });
    expect(await cancelled.json()).toMatchObject({
      status: 'cancelled',
      usdt: { checkStatus: 'done' },
    });
    const [row] = await test.db
      .select({ open: usdtDeposits.depositOpen })
      .from(usdtDeposits)
      .where(eq(usdtDeposits.depositId, deposit.id));
    expect(row?.open).toBe(false);
  });

  it('refuses a receipt, a requote and the Sham Cash decisions on a USDT deposit', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie);
    const data = new FormData();
    data.set('file', new Blob([new Uint8Array(8)]), 'r.png');
    for (const response of [
      await client.post(`/api/deposits/${deposit.id}/receipt`, {
        cookie: someone.cookie,
        form: data,
      }),
      await client.post(`/api/deposits/${deposit.id}/quote`, { cookie: someone.cookie }),
    ]) {
      expect(await body(response)).toMatchObject({ status: 409, code: 'DEPOSIT_STATE_CONFLICT' });
    }
    const { deposit: reviewed } = await inReview(await customer());
    for (const response of [
      await client.post(`/api/admin/deposits/${reviewed.id}/approve`, {
        cookie: admin.cookie,
        body: {
          transactionNumber: 'T-1',
          receivedCurrency: 'USD',
          receivedAmountUnits: USD,
          referenceCheck: 'matches',
          acknowledgedFlags: ['amount_mismatch'],
        },
        headers: { 'idempotency-key': randomUUID() },
      }),
      await client.post(`/api/admin/deposits/${reviewed.id}/request-receipt`, {
        cookie: admin.cookie,
        body: { internalNote: 'A clearer one' },
      }),
    ]) {
      expect(await body(response)).toMatchObject({ status: 409, code: 'DEPOSIT_STATE_CONFLICT' });
    }
  });
});

describe('the review of a USDT deposit (rules U11, U15)', () => {
  it('shows the transfer, the review reason and the candidates', async () => {
    const someone = await customer();
    const { deposit, received, transfer: bound } = await inReview(someone);
    // Another customer's open deposit with the received amount: the transfer may be theirs.
    const other = await customer();
    const view = await adminDeposit(deposit.id);
    expect(view).toMatchObject({
      status: 'submitted',
      decidedBy: null,
      usdt: {
        checkStatus: 'review',
        reviewReasons: ['amount_mismatch'],
        receivedAmountUnits: received,
        transfer: { id: bound.id, amountUnits: received },
      },
    });
    const mine = await client.get(`/api/deposits/${deposit.id}`, { cookie: someone.cookie });
    expect(await mine.json()).toMatchObject({
      usdt: {
        checkStatus: 'review',
        reviewReasons: ['amount_mismatch'],
        receivedAmountUnits: received,
      },
    });
    // Same tail on another amount: a candidate (an exchange that took a whole-dollar fee).
    const sameTail = await created(other.cookie);
    const tail = view.usdt.tailUnits;
    const fromOther = await transfer({
      amountUnits: sameTail.usdt.payAmountUnits - (sameTail.usdt.payAmountUnits % 10_000) + tail,
    });
    expect(fromOther.amountUnits % 10_000).toBe(tail);
    const list = (await (
      await client.get('/api/admin/usdt-transfers', { cookie: admin.cookie })
    ).json()) as { items: { id: string; candidates: { depositId: string }[] }[] };
    const listed = list.items.find((item) => item.id === fromOther.id);
    expect(listed?.candidates.map((candidate) => candidate.depositId)).toContain(deposit.id);
  });

  it('needs a re-authentication, and every flag acknowledged', async () => {
    const { deposit } = await inReview(await customer());
    expect(
      await body(
        await approveUsdt(
          deposit.id,
          { acknowledgedFlags: ['amount_mismatch'] },
          { cookie: plainAdmin },
        ),
      ),
    ).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    await reauthenticate();
    expect(await body(await approveUsdt(deposit.id, { acknowledgedFlags: [] }))).toMatchObject({
      status: 409,
      code: 'FLAGS_NOT_ACKNOWLEDGED',
      details: { expected: ['amount_mismatch'] },
    });
  });

  it('credits the received amount floored to cents, with the rest in deposit_rounding, once', async () => {
    await reauthenticate();
    const someone = await customer();
    const { deposit, received, transfer: bound } = await inReview(someone);
    const credited = Math.floor(received / 10_000) * 10_000;
    const key = randomUUID();
    const response = await approveUsdt(
      deposit.id,
      { acknowledgedFlags: ['amount_mismatch'], internalNote: 'Exchange fee taken' },
      { key },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'credited',
      decidedBy: 'admin',
      credit: {
        transactionNumber: bound.txid,
        receivedCurrency: 'USD',
        receivedAmountUnits: received,
        creditedUsdUnits: credited,
        referenceCheck: null,
      },
      usdt: { checkStatus: 'done' },
    });
    expect(await postingsOf(deposit.id)).toEqual([
      { code: 'usdt_receipts:usdt_trc20', amountUnits: -received },
      { code: `customer_wallet:${someone.id}`, amountUnits: credited },
      { code: 'deposit_rounding:USD', amountUnits: received - credited },
    ]);
    const emails = (await emailsTo(test.db, someone.email)).filter(
      (email) => email.template === 'customer_deposit_credited',
    );
    expect(emails).toHaveLength(1);
    expect(JSON.stringify(emails[0]?.params)).not.toContain(bound.txid);
    expect((await notificationsOf(test.db, someone.id)).map((item) => item.event)).toEqual([
      'deposit_credited',
    ]);
    const audit = (await auditOf(test.db, deposit.id)).at(-1);
    expect(audit).toMatchObject({
      action: 'deposit.credited',
      actorKind: 'admin',
      reason: 'Exchange fee taken',
      details: expect.objectContaining({
        decidedBy: 'admin',
        acknowledgedFlags: ['amount_mismatch'],
        referenceCheck: null,
      }),
    });
    // The same key replays; another body with it is refused.
    const again = await approveUsdt(
      deposit.id,
      { acknowledgedFlags: ['amount_mismatch'] },
      { key },
    );
    expect(again.status).toBe(200);
    expect(
      await body(await approveUsdt(deposit.id, { acknowledgedFlags: [] }, { key })),
    ).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(
      await body(await approveUsdt(deposit.id, { acknowledgedFlags: ['amount_mismatch'] })),
    ).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
    });
    // The wallet timeline names the method; the admin's adds the TXID.
    const timeline = (await (
      await client.get('/api/wallet/entries', { cookie: someone.cookie })
    ).json()) as { items: { deposit: unknown }[] };
    expect(timeline.items[0]?.deposit).toMatchObject({ method: 'usdt_trc20' });
    const adminTimeline = (await (
      await client.get(`/api/admin/wallets/${someone.id}/entries`, { cookie: admin.cookie })
    ).json()) as { items: { deposit: unknown }[] };
    expect(adminTimeline.items[0]?.deposit).toMatchObject({ id: deposit.id, txid: bound.txid });
  });

  it("credits a wrong-network transfer from that network's receipts, claimed under it (edge case 8)", async () => {
    await reauthenticate();
    const someone = await customer();
    const { deposit, transfer: bound } = await inReview(someone, {
      method: 'usdt_bep20',
      received: (pay) => pay,
    });
    const response = await approveUsdt(deposit.id, { acknowledgedFlags: ['wrong_network'] });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await postingsOf(deposit.id))[0]?.code).toBe('usdt_receipts:usdt_bep20');
    const claims = await test.db
      .select({ method: paymentReferences.method })
      .from(paymentReferences)
      .where(eq(paymentReferences.reference, bound.txid.toUpperCase()));
    expect(claims).toEqual([{ method: 'usdt_bep20' }]);
  });

  it('credits once when two approvals race', async () => {
    await reauthenticate();
    const { deposit } = await inReview(await customer());
    const responses = await Promise.all([
      approveUsdt(deposit.id, { acknowledgedFlags: ['amount_mismatch'] }),
      approveUsdt(deposit.id, { acknowledgedFlags: ['amount_mismatch'] }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const journals = await test.db
      .select({ id: ledgerJournals.id })
      .from(ledgerJournals)
      .where(eq(ledgerJournals.idempotencyKey, `deposit:${deposit.id}`));
    expect(journals).toHaveLength(1);
  });

  it('lets one of an approval and an S02 manual deposit with the TXID as 0x claim the transfer', async () => {
    await reauthenticate();
    const someone = await customer();
    const { deposit, transfer: bound, received } = await inReview(someone);
    const [approval, adjustment] = await Promise.all([
      approveUsdt(deposit.id, { acknowledgedFlags: ['amount_mismatch'] }),
      client.post(`/api/admin/wallets/${someone.id}/adjustments`, {
        cookie: admin.cookie,
        body: {
          direction: 'credit',
          amountUnits: Math.floor(received / 10_000) * 10_000,
          amountConfirmationUnits: Math.floor(received / 10_000) * 10_000,
          category: 'manual_deposit',
          reason: 'The same transfer by hand',
          depositMethod: 'usdt_trc20',
          externalReference: `0X${bound.txid.toUpperCase()}`,
        },
        headers: { 'idempotency-key': randomUUID() },
      }),
    ]);
    expect([approval.status === 200, adjustment.status === 201].filter(Boolean)).toHaveLength(1);
    const loser = approval.status === 200 ? adjustment : approval;
    expect(await body(loser)).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_TAKEN' });
    if (approval.status !== 200) {
      // The refused approval left nothing behind.
      expect(await postingsOf(deposit.id)).toEqual([]);
      expect((await adminDeposit(deposit.id)).status).toBe('submitted');
    }
  });

  it('refuses a deposit not in review, a Sham Cash deposit and an unknown one', async () => {
    await reauthenticate();
    const someone = await customer();
    const pending = await created(someone.cookie);
    expect(await body(await approveUsdt(pending.id, { acknowledgedFlags: [] }))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
    });
    expect(await body(await approveUsdt(randomUUID(), { acknowledgedFlags: [] }))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('rejecting and re-checking a USDT deposit (rules U16, U17)', () => {
  it('rejects from review only, leaves the TXID unclaimed, and emails the reason', async () => {
    const someone = await customer();
    const pending = await created(someone.cookie);
    const reject = (id: string) =>
      client.post(`/api/admin/deposits/${id}/reject`, {
        cookie: admin.cookie,
        body: { reason: 'transfer_other_customer', internalNote: 'Paid by someone else' },
        headers: { 'idempotency-key': randomUUID() },
      });
    expect(await body(await reject(pending.id))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
    });
    const other = await customer();
    const { deposit, transfer: bound } = await inReview(other);
    const response = await reject(deposit.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'rejected',
      decidedBy: 'admin',
      rejection: { reason: 'transfer_other_customer' },
      usdt: { checkStatus: 'done' },
    });
    const claims = await test.db
      .select()
      .from(paymentReferences)
      .where(eq(paymentReferences.reference, bound.txid.toUpperCase()));
    expect(claims).toEqual([]);
    expect((await emailsTo(test.db, other.email)).map((email) => email.template)).toContain(
      'customer_deposit_rejected',
    );
    expect((await notificationsOf(test.db, other.id)).map((item) => item.event)).toContain(
      'deposit_rejected',
    );
    // Rejected, its transfer is unmatched again: its owner can still be credited by hand.
    const list = (await (
      await client.get('/api/admin/usdt-transfers', { cookie: admin.cookie })
    ).json()) as { items: { id: string; state: string }[] };
    expect(list.items.find((item) => item.id === bound.id)?.state).toBe('unmatched');
  });

  it('re-sends the verification of a submitted deposit, audited, and nothing else', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie);
    const recheck = (id: string) =>
      client.post(`/api/admin/deposits/${id}/recheck`, { cookie: admin.cookie });
    expect(await body(await recheck(deposit.id))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
    });
    expect((await submitTxid(someone.cookie, deposit.id, txid())).status).toBe(200);
    const response = await recheck(deposit.id);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'submitted',
      usdt: { checkStatus: 'searching' },
    });
    expect(await actionsOf(deposit.id)).toContain('deposit.rechecked');
    // The first job is still queued: one verification per deposit at a time.
    expect(await verifyJobs(deposit.id)).toBe(1);
  });

  it('settles an approval racing a re-check with one credit', async () => {
    await reauthenticate();
    const { deposit } = await inReview(await customer());
    const [approval, recheck] = await Promise.all([
      approveUsdt(deposit.id, { acknowledgedFlags: ['amount_mismatch'] }),
      client.post(`/api/admin/deposits/${deposit.id}/recheck`, { cookie: admin.cookie }),
    ]);
    expect(approval.status).toBe(200);
    expect([202, 409]).toContain(recheck.status);
    expect(await postingsOf(deposit.id)).toHaveLength(3);
  });
});

describe('the USDT transfers (rule U13) and the badge', () => {
  it('lists unmatched transfers by default, all on request, by network, with a cursor', async () => {
    const before = (await (
      await client.get('/api/admin/deposits/counts', { cookie: admin.cookie })
    ).json()) as { unmatchedTransfers: number; usdtReview: number };
    const loose = await transfer({ amountUnits: 7_123_400 });
    const { transfer: reviewed } = await inReview(await customer());
    const after = (await (
      await client.get('/api/admin/deposits/counts', { cookie: admin.cookie })
    ).json()) as { unmatchedTransfers: number; usdtReview: number };
    expect(after.unmatchedTransfers).toBe(before.unmatchedTransfers + 1);
    expect(after.usdtReview).toBe(before.usdtReview + 1);

    const unmatched = (await (
      await client.get('/api/admin/usdt-transfers?limit=100', { cookie: admin.cookie })
    ).json()) as { items: { id: string; state: string }[] };
    expect(unmatched.items.map((item) => item.id)).toContain(loose.id);
    expect(unmatched.items.map((item) => item.id)).not.toContain(reviewed.id);
    expect(unmatched.items.every((item) => item.state === 'unmatched')).toBe(true);

    const all = (await (
      await client.get('/api/admin/usdt-transfers?state=all&limit=100', { cookie: admin.cookie })
    ).json()) as { items: { id: string; state: string; holder: { kind: string } | null }[] };
    expect(all.items.find((item) => item.id === reviewed.id)).toMatchObject({
      state: 'bound',
      holder: { kind: 'deposit' },
    });

    const bsc = (await (
      await client.get('/api/admin/usdt-transfers?method=usdt_bep20&state=all', {
        cookie: admin.cookie,
      })
    ).json()) as { items: { method: string }[] };
    expect(bsc.items.every((item) => item.method === 'usdt_bep20')).toBe(true);

    const first = (await (
      await client.get('/api/admin/usdt-transfers?state=all&limit=1', { cookie: admin.cookie })
    ).json()) as { items: { id: string }[]; nextCursor: string };
    const next = (await (
      await client.get(`/api/admin/usdt-transfers?state=all&limit=1&cursor=${first.nextCursor}`, {
        cookie: admin.cookie,
      })
    ).json()) as { items: { id: string }[] };
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it('shows a transfer credited by an S02 manual deposit with its holder', async () => {
    await reauthenticate();
    const someone = await customer();
    const loose = await transfer({ amountUnits: 7_123_400 });
    const adjustment = await client.post(`/api/admin/wallets/${someone.id}/adjustments`, {
      cookie: admin.cookie,
      body: {
        direction: 'credit',
        amountUnits: 7_120_000,
        category: 'manual_deposit',
        reason: 'An unmatched transfer',
        depositMethod: 'usdt_trc20',
        externalReference: `https://tronscan.org/#/transaction/${loose.txid}`,
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(adjustment.status, await adjustment.clone().text()).toBe(201);
    const all = (await (
      await client.get('/api/admin/usdt-transfers?state=all&limit=100', { cookie: admin.cookie })
    ).json()) as { items: { id: string; state: string; holder: unknown }[] };
    expect(all.items.find((item) => item.id === loose.id)).toMatchObject({
      state: 'credited',
      holder: { kind: 'adjustment', customer: { id: someone.id } },
    });
    // Its TXID can no longer start a deposit's verification.
    const deposit = await created(someone.cookie);
    expect(await body(await submitTxid(someone.cookie, deposit.id, loose.txid))).toMatchObject({
      code: 'EXTERNAL_REFERENCE_TAKEN',
    });
  });

  it('filters the queue by method', async () => {
    const { deposit } = await inReview(await customer());
    const page = (await (
      await client.get('/api/admin/deposits?method=usdt_trc20&limit=100', { cookie: admin.cookie })
    ).json()) as { items: { id: string; method: string }[] };
    expect(page.items.every((item) => item.method === 'usdt_trc20')).toBe(true);
    expect(page.items.map((item) => item.id)).toContain(deposit.id);
    const sham = (await (
      await client.get('/api/admin/deposits?method=sham_cash&limit=100', { cookie: admin.cookie })
    ).json()) as { items: { id: string }[] };
    expect(sham.items.map((item) => item.id)).not.toContain(deposit.id);
  });
});

describe('USDT reviews from Telegram (S05 rules TC3, TC4, TC5)', () => {
  const chatId = 8_000_000_000 + randomInt(1_000_000_000);
  const from = { id: chatId, username: `owner${chatId}` };
  const chat = { id: chatId, type: 'private' };
  let nextUpdateId = Date.now() * 1000 + 900_000;
  const post = async (update: object) => {
    nextUpdateId += 1;
    const response = await fetch(`${test.url}/api/webhooks/telegram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret-0123456789abcdef',
      },
      body: JSON.stringify({ update_id: nextUpdateId, ...update }),
    });
    const text = await response.text();
    return text ? (JSON.parse(text) as { text?: string }).text : undefined;
  };
  const sendText = (text: string) => post({ message: { message_id: 1, from, chat, text } });
  const tap = (data: string) =>
    post({ callback_query: { id: 'q', from, message: { message_id: 2, chat }, data } });
  const lastReply = async () =>
    (
      await test.db
        .select({ params: telegramMessages.params })
        .from(telegramMessages)
        .where(eq(telegramMessages.chatId, chatId))
        .orderBy(asc(telegramMessages.createdAt), asc(telegramMessages.id))
    ).at(-1)?.params as Record<string, unknown> | undefined;

  beforeAll(async () => {
    await test.db
      .update(telegramLinks)
      .set({ unlinkedAt: new Date() })
      .where(isNull(telegramLinks.unlinkedAt));
    await reauthenticate();
    const code = await client.post('/api/admin/telegram/link-code', { cookie: admin.cookie });
    const { deepLink } = (await code.json()) as { deepLink: string };
    await sendText(`/start ${new URL(deepLink).searchParams.get('start')}`);
    expect(await lastReply()).toEqual({ reply: 'welcome' });
  });

  it('never approves a USDT review, and rejects it with the USDT reasons', async () => {
    const someone = await customer();
    const { deposit } = await inReview(someone);
    expect(await tap(`ap:${deposit.id}`)).toMatch(/اللوحة/);
    expect(await tap(`rj:${deposit.id}`)).toBeUndefined();
    const reasons = await lastReply();
    expect(reasons).toMatchObject({ reply: 'reject_reasons' });
    expect(reasons?.reasons).toContain('transfer_other_customer');
    await tap(`rr:${reasons?.promptId}:transfer_other_customer`);
    await sendText('The transfer belongs to another customer');
    expect(await lastReply()).toMatchObject({ reply: 'rejected' });
    const [row] = await test.db.select().from(deposits).where(eq(deposits.id, deposit.id));
    expect(row).toMatchObject({ status: 'rejected', rejectReason: 'transfer_other_customer' });
    const [check] = await test.db
      .select({ checkStatus: usdtDeposits.checkStatus })
      .from(usdtDeposits)
      .where(eq(usdtDeposits.depositId, deposit.id));
    expect(check?.checkStatus).toBe('done');
    expect(
      (await auditOf(test.db, deposit.id)).find((entry) => entry.action === 'deposit.rejected'),
    ).toMatchObject({ channel: 'telegram' });
  });

  it('refuses a USDT deposit that is not in review', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie);
    expect(await tap(`rj:${deposit.id}`)).toMatch(/البت فيه/);
  });
});
