import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { CURRENCY_SCALE } from '@vertex-digital/contracts';
import {
  customers,
  emailOutbox,
  ledgerJournals,
  paymentReferences,
  walletAdjustments,
} from '@vertex-digital/db';
import { count, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  body,
  emailsTo,
  PASSWORD,
  removeAccounts,
  type Seeded,
  seedCustomer,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Wallets and adjustments (S02) over HTTP against the test database. Customers who got a wallet
 * stay in the database with their ledger rows and adjustments (append-only by design).
 */

const DOLLAR = CURRENCY_SCALE.USD;

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

interface Customer extends Seeded {
  cookie: string;
  name: string;
  phone: string;
}

/** A signed-in customer with a unique name and phone, so searches find exactly them. */
async function newCustomer(isTest = false): Promise<Customer> {
  const customer = await seedCustomer(test.db, { isTest });
  seeded.push(customer.id);
  const name = `محفظة ${randomUUID().slice(0, 8)}`;
  const phone = `+9639${randomInt(10_000_000, 99_999_999)}`;
  await test.db.update(customers).set({ name, phone }).where(eq(customers.id, customer.id));
  return { ...customer, name, phone, cookie: await client.signInCustomer(customer.email) };
}

const adjust = (customerId: string, input: Record<string, unknown>, key: string = randomUUID()) =>
  client.post(`/api/admin/wallets/${customerId}/adjustments`, {
    cookie: admin.cookie,
    body: { reason: 'Test adjustment', ...input },
    headers: { 'idempotency-key': key },
  });

const reverse = (
  adjustmentId: string,
  input: Record<string, unknown> = {},
  key: string = randomUUID(),
) =>
  client.post(`/api/admin/wallet-adjustments/${adjustmentId}/reverse`, {
    cookie: admin.cookie,
    body: { reason: 'Test reversal', ...input },
    headers: { 'idempotency-key': key },
  });

const credit = (customerId: string, dollars: number, category = 'compensation') =>
  adjust(customerId, { direction: 'credit', amountUnits: dollars * DOLLAR, category });

const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });

/** The wallet emails to a customer (signing in also queues a new-sign-in email). */
const adjustmentEmails = async (customer: Customer) =>
  (await emailsTo(test.db, customer.email)).filter(
    (email) => email.template === 'customer_wallet_adjusted',
  );

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session on every route', async () => {
    const id = randomUUID();
    for (const response of await Promise.all([
      client.get('/api/wallet'),
      client.get('/api/wallet/entries'),
      client.get('/api/admin/wallets?q=abc'),
      client.get(`/api/admin/wallets/${id}`),
      client.get(`/api/admin/wallets/${id}/entries`),
      client.get('/api/admin/ledger/summary'),
      client.post(`/api/admin/wallets/${id}/adjustments`, { body: {} }),
      client.post(`/api/admin/wallet-adjustments/${id}/reverse`, { body: {} }),
    ])) {
      expect(response.status).toBe(401);
    }
  });

  it('refuses an admin session on the customer routes and a customer session on admin routes', async () => {
    const customer = await newCustomer();
    expect((await client.get('/api/wallet', { cookie: admin.cookie })).status).toBe(401);
    expect((await client.get('/api/wallet/entries', { cookie: admin.cookie })).status).toBe(401);
    for (const path of [
      '/api/admin/wallets?q=abc',
      `/api/admin/wallets/${customer.id}`,
      '/api/admin/ledger/summary',
    ]) {
      expect((await client.get(path, { cookie: customer.cookie })).status).toBe(401);
    }
    const adjusted = await client.post(`/api/admin/wallets/${customer.id}/adjustments`, {
      cookie: customer.cookie,
      body: { direction: 'credit', amountUnits: DOLLAR, category: 'compensation', reason: 'Self' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(adjusted.status).toBe(401);
  });

  it('needs a re-authentication to adjust and to reverse (rule J7)', async () => {
    const customer = await newCustomer();
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    const asFresh = (path: string) =>
      client.post(path, {
        cookie: fresh.cookie,
        body: {
          direction: 'credit',
          amountUnits: DOLLAR,
          category: 'compensation',
          reason: 'Late',
        },
        headers: { 'idempotency-key': randomUUID() },
      });
    expect(
      await body(await asFresh(`/api/admin/wallets/${customer.id}/adjustments`)),
    ).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    expect(
      await body(await asFresh(`/api/admin/wallet-adjustments/${randomUUID()}/reverse`)),
    ).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    // The fresh admin replaced the one of this file (there is only one): restore it.
    admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    await client.post('/api/admin/me/reauthenticate', {
      cookie: admin.cookie,
      body: { password: PASSWORD, totpCode: totp(admin.secret) },
    });
  });
});

describe('the customer wallet (rules W1–W10)', () => {
  it('starts at zero with an empty timeline, never cached, and creates nothing', async () => {
    const customer = await newCustomer();
    const wallet = await client.get('/api/wallet', { cookie: customer.cookie });
    expect(wallet.headers.get('cache-control')).toBe('no-store');
    // S03 rates stay in the test database: the value in pounds follows the rate in force.
    expect(await json(wallet)).toMatchObject({ balanceUnits: 0 });
    const entries = await client.get('/api/wallet/entries', { cookie: customer.cookie });
    expect(entries.headers.get('cache-control')).toBe('no-store');
    expect(await json(entries)).toEqual({ items: [], nextCursor: null });
    expect(await json(await adminGet(`/api/admin/wallets/${customer.id}`))).toMatchObject({
      balanceUnits: 0,
      adjustmentCount: 0,
    });
  });

  it('shows each customer only their own entries, without the internal details', async () => {
    const [one, two] = [await newCustomer(), await newCustomer()];
    await adjust(one.id, {
      direction: 'credit',
      amountUnits: 25 * DOLLAR,
      category: 'compensation',
      reason: 'Internal: late order 42',
      customerNote: 'تعويض عن التأخير',
    });
    await credit(two.id, 7);
    const page = await json<{ items: Record<string, unknown>[] }>(
      await client.get('/api/wallet/entries', { cookie: one.cookie }),
    );
    expect(page.items).toEqual([
      {
        occurredAt: expect.any(String),
        kind: 'adjustment',
        amountUnits: 25 * DOLLAR,
        balanceAfterUnits: 25 * DOLLAR,
        adjustment: { category: 'compensation', customerNote: 'تعويض عن التأخير', reversal: false },
        deposit: null,
      },
    ]);
    expect(JSON.stringify(page)).not.toMatch(/Internal|journal|admin/i);
    expect(await json(await client.get('/api/wallet', { cookie: two.cookie }))).toMatchObject({
      balanceUnits: 7 * DOLLAR,
    });
  });

  it('pages with a cursor and refuses a bad one', async () => {
    const customer = await newCustomer();
    for (const dollars of [1, 2, 3]) await credit(customer.id, dollars);
    const first = await json<{ items: { amountUnits: number }[]; nextCursor: string }>(
      await client.get('/api/wallet/entries?limit=2', { cookie: customer.cookie }),
    );
    expect(first.items.map((item) => item.amountUnits / DOLLAR)).toEqual([3, 2]);
    const second = await json<{ items: { balanceAfterUnits: number }[]; nextCursor: null }>(
      await client.get(`/api/wallet/entries?limit=2&cursor=${first.nextCursor}`, {
        cookie: customer.cookie,
      }),
    );
    expect(second).toEqual({
      items: [expect.objectContaining({ amountUnits: DOLLAR, balanceAfterUnits: DOLLAR })],
      nextCursor: null,
    });
    const bad = await client.get('/api/wallet/entries?cursor=nope', { cookie: customer.cookie });
    expect(await body(bad)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('the admin wallet screens', () => {
  it('search by 3 characters of the name, a phone or email prefix, with balances', async () => {
    const customer = await newCustomer();
    await credit(customer.id, 4);
    const search = async (q: string) =>
      json<{ items: { id: string; balanceUnits: number }[] }>(
        await adminGet(`/api/admin/wallets?q=${encodeURIComponent(q)}`),
      );
    for (const q of [
      customer.name.slice(-6),
      customer.phone,
      customer.phone.slice(1, 9),
      customer.email.slice(0, 12).toUpperCase(),
    ]) {
      expect((await search(q)).items, q).toContainEqual(
        expect.objectContaining({ id: customer.id, balanceUnits: 4 * DOLLAR, isTest: false }),
      );
    }
    expect((await search('%%%')).items).toEqual([]);
    expect(await body(await adminGet('/api/admin/wallets?q=ab'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('answer 404 for an unknown or malformed customer id (edge case 12)', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      expect((await adminGet(`/api/admin/wallets/${id}`)).status).toBe(404);
      expect((await adminGet(`/api/admin/wallets/${id}/entries`)).status).toBe(404);
      expect(await body(await credit(id, 1))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(await body(await reverse(id))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });

  it('show the admin the reason, the admin and the reversal links', async () => {
    const customer = await newCustomer();
    const original = await json<{ id: string }>(await credit(customer.id, 6));
    const reversal = await json<{ id: string }>(await reverse(original.id));
    const page = await json<{ items: { adjustment: Record<string, unknown> }[] }>(
      await adminGet(`/api/admin/wallets/${customer.id}/entries`),
    );
    expect(page.items.map((item) => item.adjustment)).toEqual([
      expect.objectContaining({
        id: reversal.id,
        reversal: true,
        reversesAdjustmentId: original.id,
        reason: 'Test reversal',
        adminName: 'مدير اختبار',
      }),
      expect.objectContaining({ id: original.id, reversedByAdjustmentId: reversal.id }),
    ]);
    expect(await json(await adminGet(`/api/admin/wallets/${customer.id}`))).toMatchObject({
      customer: { id: customer.id, name: customer.name, isTest: false },
      balanceUnits: 0,
      adjustmentCount: 2,
    });
  });

  it('summarise what is owed, real and test customers apart (rule L1)', async () => {
    const response = await adminGet('/api/admin/ledger/summary');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const summary = await json<{ systemAccounts: { code: string }[] }>(response);
    expect(summary).toMatchObject({
      owedToCustomersUnits: expect.any(Number),
      owedToTestCustomersUnits: expect.any(Number),
      walletsWithBalance: expect.any(Number),
    });
    expect(summary.systemAccounts.map((account) => account.code)).toContain(
      'adjustments:compensation',
    );
  });
});

describe('adjustments (rules J1–J10)', () => {
  it('credit the wallet with its journal, audit entry and email, in one go (rules J2, J3)', async () => {
    const customer = await newCustomer();
    const response = await adjust(customer.id, {
      direction: 'credit',
      amountUnits: 25 * DOLLAR,
      category: 'compensation',
      reason: 'Late delivery on order 42',
      customerNote: 'نعتذر عن التأخير',
    });
    expect(response.status).toBe(201);
    const adjustment = await json<{ id: string; journalId: string }>(response);
    expect(adjustment).toMatchObject({
      customerId: customer.id,
      direction: 'credit',
      amountUnits: 25 * DOLLAR,
      category: 'compensation',
      reason: 'Late delivery on order 42',
      balanceAfterUnits: 25 * DOLLAR,
      reversesAdjustmentId: null,
    });
    const [journal] = await test.db
      .select()
      .from(ledgerJournals)
      .where(eq(ledgerJournals.id, adjustment.journalId));
    expect(journal).toMatchObject({
      kind: 'adjustment',
      idempotencyKey: `adjustment:${adjustment.id}`,
    });
    expect(await auditOf(test.db, adjustment.id)).toMatchObject([
      {
        action: 'wallet_adjustment.created',
        actorKind: 'admin',
        actorId: admin.id,
        entityType: 'wallet_adjustment',
        reason: 'Late delivery on order 42',
        details: {
          customerId: customer.id,
          direction: 'credit',
          amountUnits: 25 * DOLLAR,
          balanceAfterUnits: 25 * DOLLAR,
          customerNote: 'نعتذر عن التأخير',
        },
      },
    ]);
    const emails = await adjustmentEmails(customer);
    expect(emails.map((email) => [email.template, email.priority])).toEqual([
      ['customer_wallet_adjusted', 'normal'],
    ]);
    expect(emails[0]?.params).toEqual({
      at: expect.any(String),
      direction: 'credit',
      amountUnits: 25 * DOLLAR,
      category: 'compensation',
      reversal: false,
    });
  });

  it('refuse a direction the category does not allow (rule J1)', async () => {
    const customer = await newCustomer();
    const response = await adjust(customer.id, {
      direction: 'debit',
      amountUnits: DOLLAR,
      category: 'compensation',
    });
    expect(await body(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('give test funds to test customers only (rule J4)', async () => {
    const [real, tester] = [await newCustomer(), await newCustomer(true)];
    const input = { direction: 'credit', amountUnits: DOLLAR, category: 'test_funds' };
    expect(await body(await adjust(real.id, input))).toMatchObject({
      status: 400,
      code: 'ADJUSTMENT_NOT_ALLOWED',
    });
    expect((await adjust(tester.id, input)).status).toBe(201);
  });

  it('never take a wallet below zero, and leave nothing behind when refused (rule J5)', async () => {
    const customer = await newCustomer();
    await credit(customer.id, 5);
    const before = await rowsOf(customer);
    const response = await adjust(customer.id, {
      direction: 'debit',
      amountUnits: 1_000 * DOLLAR,
      amountConfirmationUnits: 1_000 * DOLLAR,
      category: 'cash_refund',
    });
    expect(await body(response)).toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_BALANCE',
      details: { balanceUnits: 5 * DOLLAR },
    });
    expect(await rowsOf(customer)).toEqual(before);
  });

  it('need the amount typed twice above $100, not at $100 (rule J6, edge cases 9, 10)', async () => {
    const customer = await newCustomer();
    const input = { direction: 'credit', category: 'compensation' };
    expect(
      await body(await adjust(customer.id, { ...input, amountUnits: 250 * DOLLAR })),
    ).toMatchObject({ status: 400, code: 'AMOUNT_CONFIRMATION_REQUIRED' });
    expect(
      await body(
        await adjust(customer.id, {
          ...input,
          amountUnits: 250 * DOLLAR,
          amountConfirmationUnits: 25 * DOLLAR,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'AMOUNT_CONFIRMATION_MISMATCH' });
    expect(
      await body(
        await adjust(customer.id, {
          ...input,
          amountUnits: 10 * DOLLAR,
          amountConfirmationUnits: 11 * DOLLAR,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'AMOUNT_CONFIRMATION_MISMATCH' });
    expect((await adjust(customer.id, { ...input, amountUnits: 100 * DOLLAR })).status).toBe(201);
    const confirmed = await adjust(customer.id, {
      ...input,
      amountUnits: 250 * DOLLAR,
      amountConfirmationUnits: 250 * DOLLAR,
    });
    expect(await json(confirmed)).toMatchObject({ balanceAfterUnits: 350 * DOLLAR });
  });

  it('record a manual deposit reference once per method, whatever its case (rule J8)', async () => {
    const customer = await newCustomer();
    const reference = `ABC${randomInt(100_000, 999_999)}`;
    const manual = (externalReference: string, depositMethod = 'sham_cash') =>
      adjust(customer.id, {
        direction: 'credit',
        amountUnits: DOLLAR,
        category: 'manual_deposit',
        depositMethod,
        externalReference,
      });
    const first = await manual(reference);
    expect(first.status).toBe(201);
    // `details` names the record holding the reference (S03 rule SC14).
    expect(await body(await manual(` ${reference.toLowerCase()} `))).toMatchObject({
      status: 409,
      code: 'EXTERNAL_REFERENCE_TAKEN',
      details: { kind: 'adjustment', id: (await json(first)).id },
    });
    const claims = await test.db
      .select({ method: paymentReferences.method, reference: paymentReferences.reference })
      .from(paymentReferences)
      .where(eq(paymentReferences.reference, reference));
    expect(claims).toEqual([{ method: 'sham_cash', reference }]);
    // A USDT reference is a TXID, claimed as the worker claims it: `0x`, a link or another
    // case are the same claim (S04).
    expect(await body(await manual(reference, 'usdt_trc20'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const txid = randomBytes(32).toString('hex');
    expect((await manual(`0x${txid}`, 'usdt_trc20')).status).toBe(201);
    expect(
      await body(
        await manual(`https://tronscan.org/#/transaction/${txid.toUpperCase()}`, 'usdt_trc20'),
      ),
    ).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_TAKEN' });
    expect(
      await body(
        await adjust(customer.id, {
          direction: 'credit',
          amountUnits: DOLLAR,
          category: 'manual_deposit',
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('need a UUID Idempotency-Key, and replay the first result for it (rule J9)', async () => {
    const customer = await newCustomer();
    const input = { direction: 'credit', amountUnits: 3 * DOLLAR, category: 'compensation' };
    for (const headers of [{}, { 'idempotency-key': 'not-a-uuid' }] as Record<string, string>[]) {
      const response = await client.post(`/api/admin/wallets/${customer.id}/adjustments`, {
        cookie: admin.cookie,
        body: { ...input, reason: 'Test adjustment' },
        headers,
      });
      expect(await body(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    const key = randomUUID();
    const first = await adjust(customer.id, input, key);
    expect(first.status).toBe(201);
    const again = await adjust(customer.id, input, key.toUpperCase());
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe((await json(first)).id);
    expect(
      await body(await adjust(customer.id, { ...input, amountUnits: 4 * DOLLAR }, key)),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await adjustmentEmails(customer)).toHaveLength(1);
  });
});

describe('reversals (rules R1–R5)', () => {
  it('mirror the original once, with their own audit entry and email (rules R1, R2)', async () => {
    const customer = await newCustomer();
    await credit(customer.id, 10);
    const original = await json<{ id: string }>(await credit(customer.id, 4));
    const response = await reverse(original.id, { customerNote: 'أُلغي التعويض' });
    expect(response.status).toBe(201);
    const reversal = await json<{ id: string }>(response);
    expect(reversal).toMatchObject({
      direction: 'debit',
      amountUnits: 4 * DOLLAR,
      category: 'compensation',
      reversesAdjustmentId: original.id,
      balanceAfterUnits: 10 * DOLLAR,
    });
    expect(await auditOf(test.db, reversal.id)).toMatchObject([
      {
        action: 'wallet_adjustment.reversed',
        reason: 'Test reversal',
        details: { reversedAdjustmentId: original.id, direction: 'debit' },
      },
    ]);
    expect((await adjustmentEmails(customer)).at(-1)?.params).toMatchObject({
      direction: 'debit',
      reversal: true,
    });
    expect(await body(await reverse(original.id))).toMatchObject({
      status: 409,
      code: 'ADJUSTMENT_ALREADY_REVERSED',
    });
    expect(await body(await reverse(reversal.id))).toMatchObject({
      status: 409,
      code: 'ADJUSTMENT_NOT_REVERSIBLE',
    });
  });

  it('refuse reversing a credit already spent, and ask for the confirmation above $100 (rules R4, J6)', async () => {
    const customer = await newCustomer();
    const original = await json<{ id: string }>(
      await adjust(customer.id, {
        direction: 'credit',
        amountUnits: 150 * DOLLAR,
        amountConfirmationUnits: 150 * DOLLAR,
        category: 'correction',
      }),
    );
    expect(await body(await reverse(original.id))).toMatchObject({
      status: 400,
      code: 'AMOUNT_CONFIRMATION_REQUIRED',
    });
    await adjust(customer.id, {
      direction: 'debit',
      amountUnits: 100 * DOLLAR,
      category: 'cash_refund',
    });
    expect(
      await body(await reverse(original.id, { amountConfirmationUnits: 150 * DOLLAR })),
    ).toMatchObject({ status: 409, code: 'INSUFFICIENT_BALANCE' });
  });

  it('reverse a manual deposit as a debit without a method, keeping its reference taken (rule R5)', async () => {
    const customer = await newCustomer();
    const reference = randomBytes(32).toString('hex');
    const original = await json<{ id: string }>(
      await adjust(customer.id, {
        direction: 'credit',
        amountUnits: 2 * DOLLAR,
        category: 'manual_deposit',
        depositMethod: 'usdt_bep20',
        externalReference: reference,
      }),
    );
    expect(await json(await reverse(original.id))).toMatchObject({
      direction: 'debit',
      category: 'manual_deposit',
      depositMethod: null,
      externalReference: null,
    });
    const again = await adjust(customer.id, {
      direction: 'credit',
      amountUnits: 2 * DOLLAR,
      category: 'manual_deposit',
      depositMethod: 'usdt_bep20',
      externalReference: reference,
    });
    expect(await body(again)).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_TAKEN' });
  });
});

/** Adjustments, journals, audit entries and emails about a customer: what a refusal must not add. */
async function rowsOf(customer: Customer) {
  const [[adjustments], [emails], [journals]] = await Promise.all([
    test.db
      .select({ count: count() })
      .from(walletAdjustments)
      .where(eq(walletAdjustments.customerId, customer.id)),
    test.db
      .select({ count: count() })
      .from(emailOutbox)
      .where(eq(emailOutbox.toAddress, customer.email)),
    test.db
      .select({ count: count() })
      .from(ledgerJournals)
      .where(like(ledgerJournals.idempotencyKey, 'adjustment:%')),
  ]);
  const audits = await Promise.all(
    (
      await test.db
        .select({ id: walletAdjustments.id })
        .from(walletAdjustments)
        .where(eq(walletAdjustments.customerId, customer.id))
    ).map((row) => auditOf(test.db, row.id)),
  );
  return {
    adjustments: adjustments?.count ?? 0,
    emails: emails?.count ?? 0,
    journals: journals?.count ?? 0,
    audits: audits.flat().length,
  };
}

describe('money under concurrency', () => {
  it('lets 20 parallel debits take the wallet to zero and never below (rule J5)', async () => {
    const customer = await newCustomer(true);
    await adjust(customer.id, {
      direction: 'credit',
      amountUnits: 10 * DOLLAR,
      category: 'test_funds',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        adjust(customer.id, { direction: 'debit', amountUnits: DOLLAR, category: 'test_funds' }),
      ),
    );
    const statuses = results.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(10);
    expect(statuses.filter((status) => status === 409)).toHaveLength(10);
    expect(await json(await client.get('/api/wallet', { cookie: customer.cookie }))).toMatchObject({
      balanceUnits: 0,
    });
  });

  it('lets exactly one of two parallel reversals through (rule R2)', async () => {
    const customer = await newCustomer();
    await credit(customer.id, 50);
    const original = await json<{ id: string }>(await credit(customer.id, 5));
    const results = await Promise.all([reverse(original.id), reverse(original.id)]);
    const answers = await Promise.all(results.map((response) => body(response)));
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(answers.find((answer) => answer.status === 409)).toMatchObject({
      code: 'ADJUSTMENT_ALREADY_REVERSED',
    });
  });

  it('writes one adjustment, journal, audit entry and email for one key sent in parallel', async () => {
    const customer = await newCustomer();
    await credit(customer.id, 20);
    const before = await rowsOf(customer);
    const key = randomUUID();
    const input = { direction: 'debit', amountUnits: 15 * DOLLAR, category: 'correction' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => adjust(customer.id, input, key)),
    );
    const answers = await Promise.all(results.map((response) => body(response)));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(answers.map((answer) => answer.id)).size).toBe(1);
    const after = await rowsOf(customer);
    expect(after.adjustments - before.adjustments).toBe(1);
    expect(after.emails - before.emails).toBe(1);
    expect(after.audits - before.audits).toBe(1);
  });
});
