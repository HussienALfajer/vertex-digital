import { randomBytes, randomUUID } from 'node:crypto';
import { DEPOSIT_SETTINGS_DEFAULTS, USDT_NETWORKS } from '@vertex-digital/contracts';
import {
  ensureCustomerWallet,
  ensureSystemAccount,
  newId,
  postJournal,
  usdtScanCursors,
} from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepositReviewService } from '../src/modules/deposits/index.js';
import {
  api,
  auditOf,
  clientIp,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
  uniquePhone,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Customer administration (S12 F19) over HTTP against the test database: search, the profile and
 * its tabs, freezing and what it refuses (CF2), limits (LM2–LM5), archiving (AR1–AR3), signing out
 * everywhere, notes, the marks on the deposit page (CS6) and the Telegram approval of a frozen
 * customer's deposit (CF4). Customers with a wallet or a deposit stay (by design).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
/** A second admin session that never re-authenticated. */
let plainAdmin: string;
const seeded: string[] = [];
const USD = 1_000_000;
const REASON = 'مراجعة الحساب';

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

const image = () =>
  sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();

const form = (file: Buffer) => {
  const data = new FormData();
  data.set('file', new Blob([new Uint8Array(file)]), 'image.png');
  return data;
};

async function customer(options: { phone?: string; funds?: number; ip?: string } = {}) {
  const seededCustomer = await seedCustomer(test.db, { phone: options.phone ?? uniquePhone() });
  seeded.push(seededCustomer.id);
  if (options.funds) await fund(seededCustomer.id, options.funds);
  const response = await client.post('/api/auth/sign-in/email', {
    body: { email: seededCustomer.email, password: PASSWORD },
    ip: options.ip ?? clientIp(),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  return { ...seededCustomer, cookie };
}

type Customer = Awaited<ReturnType<typeof customer>>;

async function fund(customerId: string, amount: number) {
  await test.db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customerId), amountUnits: amount },
        {
          accountId: await ensureSystemAccount(tx, {
            code: 'adjustments:test_funds',
            kind: 'adjustments',
            currency: 'USD',
          }),
          amountUnits: -amount,
        },
      ],
    });
  });
}

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const change = (who: Customer | string, action: string, cookie = admin.cookie) =>
  client.post(`/api/admin/customers/${typeof who === 'string' ? who : who.id}/${action}`, {
    cookie,
    body: { reason: REASON },
  });
const profile = (id: string) => adminGet(`/api/admin/customers/${id}`);
const setLimits = (id: string, limits: Record<string, number | null>, cookie = admin.cookie) =>
  client.put(`/api/admin/customers/${id}/limits`, {
    cookie,
    body: {
      perDepositUsdUnits: null,
      dailyDepositUsdUnits: null,
      dailyPurchaseUsdUnits: null,
      reason: REASON,
      ...limits,
    },
  });

const shamCash = async (who: Customer, amountUnits = 5 * USD) =>
  client.post('/api/deposits/sham-cash', {
    cookie: who.cookie,
    body: { currency: 'USD', amountUnits },
    headers: { 'idempotency-key': randomUUID(), ...(await client.altcha()) },
  });

beforeAll(async () => {
  // A USDT network the frozen customer's deposit is refused on (as `deposits-usdt.test.ts`).
  process.env.USDT_TRC20_ADDRESS = USDT_NETWORKS.usdt_trc20.contract;
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  await reauthenticate();
  const qr = async () =>
    (
      await json<{ fileId: string }>(
        await client.post('/api/admin/deposit-settings/qr', {
          cookie: admin.cookie,
          form: form(await image()),
        }),
        200,
      )
    ).fileId;
  await json(
    await client.put('/api/admin/deposit-settings', {
      cookie: admin.cookie,
      body: {
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex Digital',
        shamCashAccountNumber: '0933000000',
        usdEnabled: true,
        usdQrFileId: await qr(),
        usdtTrc20Enabled: true,
      },
    }),
    200,
  );
  await test.db
    .insert(usdtScanCursors)
    .values({ method: 'usdt_trc20', cursor: '0', lastSuccessAt: sql`now()` })
    .onConflictDoUpdate({ target: usdtScanCursors.method, set: { lastSuccessAt: sql`now()` } });
});

afterAll(async () => {
  delete process.env.USDT_TRC20_ADDRESS;
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S12 "Access")', () => {
  it('admits only the admin; state and limit changes need a re-authentication', async () => {
    const someone = await customer();
    const id = someone.id;
    const routes: [string, string][] = [
      ['GET', '/api/admin/customers'],
      ['GET', `/api/admin/customers/${id}`],
      ['GET', `/api/admin/customers/${id}/sign-ins`],
      ['GET', `/api/admin/customers/${id}/sessions`],
      ['GET', `/api/admin/customers/${id}/notes`],
      ['GET', `/api/admin/customers/${id}/history`],
      ['POST', `/api/admin/customers/${id}/freeze`],
      ['POST', `/api/admin/customers/${id}/unfreeze`],
      ['POST', `/api/admin/customers/${id}/archive`],
      ['POST', `/api/admin/customers/${id}/unarchive`],
      ['POST', `/api/admin/customers/${id}/sessions/revoke`],
      ['PUT', `/api/admin/customers/${id}/limits`],
      ['POST', `/api/admin/customers/${id}/notes`],
      ['POST', `/api/admin/customers/${id}/notes/${id}/pin`],
    ];
    for (const [method, path] of routes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: someone.cookie })).status, path).toBe(
        401,
      );
    }
    for (const action of ['freeze', 'unfreeze', 'archive', 'unarchive', 'sessions/revoke']) {
      const refused = await json<{ code: string }>(await change(someone, action, plainAdmin), 403);
      expect(refused.code).toBe('REAUTHENTICATION_REQUIRED');
    }
    expect((await json<{ code: string }>(await setLimits(id, {}, plainAdmin), 403)).code).toBe(
      'REAUTHENTICATION_REQUIRED',
    );
    const read = await profile(id);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect((await json<{ code: string }>(await profile(newId()), 404)).code).toBe('NOT_FOUND');
    expect((await json<{ code: string }>(await profile('nope'), 404)).code).toBe('NOT_FOUND');
  });
});

describe('search and profile (CS1–CS5)', () => {
  it('finds a customer by email, by phone without +963, and by a deposit reference', async () => {
    const phone = uniquePhone();
    const found = await customer({ phone });
    const deposit = await json<{ referenceCode: string }>(await shamCash(found), 201);
    const search = async (q: string) =>
      (
        await json<{ items: { id: string }[] }>(
          await adminGet(`/api/admin/customers?q=${encodeURIComponent(q)}`),
          200,
        )
      ).items.map((item) => item.id);
    expect(await search(found.email.slice(0, 12))).toContain(found.id);
    expect(await search(`0${phone.slice(4)}`)).toContain(found.id);
    expect(await search(phone.slice(-7))).toContain(found.id);
    expect(await search(deposit.referenceCode.toLowerCase())).toEqual([found.id]);
    expect(await search('VO-2222ZZ')).toEqual([]);
  });

  it('shows the shared phone and shared IP signals and the default limits', async () => {
    const phone = uniquePhone();
    const ip = clientIp();
    const first = await customer({ phone, ip });
    const second = await customer({ phone, ip });
    const read = await json<{
      established: boolean;
      status: string;
      limits: { effective: Record<string, { source: string }> };
      signals: {
        sharedPhone: { count: number; customers: { id: string }[] };
        sharedIp: { count: number; customers: { id: string; ipAddresses: string[] }[] };
      };
      counts: { activeSessions: number };
    }>(await profile(first.id), 200);
    expect(read).toMatchObject({ established: false, status: 'active' });
    expect(read.limits.effective).toMatchObject({
      perDeposit: { source: 'default_new' },
      dailyPurchase: { source: 'none' },
    });
    expect(read.signals.sharedPhone.customers.map((other) => other.id)).toEqual([second.id]);
    expect(read.signals.sharedIp.customers).toEqual([
      expect.objectContaining({ id: second.id, ipAddresses: [ip] }),
    ]);
    expect(read.counts.activeSessions).toBe(1);
    const signIns = await json<{ items: { ipAddress: string }[] }>(
      await adminGet(`/api/admin/customers/${first.id}/sign-ins`),
      200,
    );
    expect(signIns.items.map((row) => row.ipAddress)).toEqual([ip]);
    const sessions = await json<unknown[]>(
      await adminGet(`/api/admin/customers/${first.id}/sessions`),
      200,
    );
    expect(sessions).toHaveLength(1);
  });
});

describe('freezing (CF1–CF6)', () => {
  it('refuses every new deposit, purchase, checkout and player check, then unfreezes', async () => {
    const frozen = await customer({ funds: 10 * USD });
    const before = await json<{ id: string; status: string }>(await shamCash(frozen), 201);
    expect(before.status).toBe('pending');
    // The pending deposit blocks a second one: cancel it first, so the freeze is what refuses.
    await json(
      await client.post(`/api/deposits/${before.id}/cancel`, { cookie: frozen.cookie }),
      200,
    );
    const frozenProfile = await json<{ status: string; statusChange: { reason: string } }>(
      await change(frozen, 'freeze'),
      200,
    );
    expect(frozenProfile).toMatchObject({ status: 'frozen', statusChange: { reason: REASON } });
    const productId = newId();
    const line = {
      productId,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: USD,
    };
    const refusals = [
      await shamCash(frozen),
      await client.post('/api/deposits/usdt', {
        cookie: frozen.cookie,
        body: { method: 'usdt_trc20', amountUnits: 10 * USD },
        headers: { 'idempotency-key': randomUUID(), ...(await client.altcha()) },
      }),
      await client.post('/api/orders', {
        cookie: frozen.cookie,
        body: line,
        headers: { 'idempotency-key': randomUUID() },
      }),
      await client.post('/api/orders', {
        cookie: frozen.cookie,
        body: { ...line, whenBalanceShort: 'reserve' },
        headers: { 'idempotency-key': randomUUID() },
      }),
      await client.post('/api/checkouts', {
        cookie: frozen.cookie,
        body: { lines: [line] },
        headers: { 'idempotency-key': randomUUID() },
      }),
      await client.post('/api/player-checks', {
        cookie: frozen.cookie,
        body: { productId, fields: { player_id: '5123456789' } },
      }),
    ];
    for (const response of refusals) {
      expect((await json<{ code: string }>(response, 403)).code).toBe('ACCOUNT_FROZEN');
    }
    const session = await json<{ user: { frozenAt: string | null } }>(
      await client.get('/api/auth/get-session', { cookie: frozen.cookie }),
      200,
    );
    expect(session.user.frozenAt).not.toBeNull();
    // Reads still work (CF3).
    expect((await client.get('/api/wallet', { cookie: frozen.cookie })).status).toBe(200);

    expect((await json<{ code: string }>(await change(frozen, 'freeze'), 409)).code).toBe(
      'CUSTOMER_STATE_INVALID',
    );
    expect((await json<{ status: string }>(await change(frozen, 'unfreeze'), 200)).status).toBe(
      'active',
    );
    expect((await shamCash(frozen)).status).toBe(201);
    const actions = (await auditOf(test.db, frozen.id)).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['customer.frozen', 'customer.unfrozen']));
  });

  it("hides Telegram's approval of a frozen customer's deposit (CF4)", async () => {
    const owner = await customer();
    const deposit = await json<{ id: string }>(await shamCash(owner), 201);
    await json(
      await client.post(`/api/deposits/${deposit.id}/receipt`, {
        cookie: owner.cookie,
        form: form(await image()),
      }),
      200,
    );
    await json(await change(owner, 'freeze'), 200);
    const facts = await test.app.get(DepositReviewService).telegramFacts(deposit.id);
    expect(facts?.approvalRefusal).toBe('frozen');
    const page = await json<{ customer: { marks: { status: string } } }>(
      await adminGet(`/api/admin/deposits/${deposit.id}`),
      200,
    );
    expect(page.customer.marks.status).toBe('frozen');
  });
});

describe('limits (LM2–LM5)', () => {
  it('overrides the deposit limits and caps purchases, with before and after audited', async () => {
    const someone = await customer();
    const limits = await json<{ effective: Record<string, { units: number; source: string }> }>(
      await setLimits(someone.id, {
        perDepositUsdUnits: 500 * USD,
        dailyDepositUsdUnits: 1_000 * USD,
        dailyPurchaseUsdUnits: USD,
      }),
      200,
    );
    expect(limits.effective).toEqual({
      perDeposit: { units: 500 * USD, source: 'custom' },
      dailyDeposit: { units: 1_000 * USD, source: 'custom' },
      dailyPurchase: { units: USD, source: 'custom' },
    });
    const options = await json<{ limits: { perDepositUnits: number } }>(
      await client.get('/api/deposits/sham-cash/options', { cookie: someone.cookie }),
      200,
    );
    expect(options.limits.perDepositUnits).toBe(500 * USD);
    const [entry] = (await auditOf(test.db, someone.id)).filter(
      (row) => row.action === 'customer.limits_changed',
    );
    expect(entry?.details).toMatchObject({
      before: { perDepositUsdUnits: null },
      after: { perDepositUsdUnits: 500 * USD },
    });
    expect(
      (
        await json<{ code: string }>(
          await setLimits(someone.id, { perDepositUsdUnits: 10 * USD, dailyDepositUsdUnits: USD }),
          400,
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    await json(await setLimits(someone.id, {}), 200);
  });
});

describe('archiving and sessions (AR1–AR3, SN1)', () => {
  it('refuses a balance, then archives: signed out, no sign-in; unarchive restores', async () => {
    const rich = await customer({ funds: USD });
    const refused = await json<{ code: string; details: { blockers: string[] } }>(
      await change(rich, 'archive'),
      409,
    );
    expect(refused).toMatchObject({
      code: 'CUSTOMER_NOT_ARCHIVABLE',
      details: { blockers: ['balance'] },
    });

    const quiet = await customer();
    expect((await json<{ status: string }>(await change(quiet, 'archive'), 200)).status).toBe(
      'archived',
    );
    expect((await client.get('/api/account', { cookie: quiet.cookie })).status).toBe(401);
    const signIn = await client.post('/api/auth/sign-in/email', {
      body: { email: quiet.email, password: PASSWORD },
    });
    expect(signIn.status).toBe(401);
    expect((await json<{ code: string }>(await setLimits(quiet.id, {}), 409)).code).toBe(
      'CUSTOMER_STATE_INVALID',
    );
    await json(await change(quiet, 'unarchive'), 200);
    expect((await client.signInCustomer(quiet.email)).length).toBeGreaterThan(0);
  });

  it('signs a customer out everywhere, in any status', async () => {
    const someone = await customer();
    const revoked = await json<{ counts: { activeSessions: number } }>(
      await change(someone, 'sessions/revoke'),
      200,
    );
    expect(revoked.counts.activeSessions).toBe(0);
    expect((await client.get('/api/account', { cookie: someone.cookie })).status).toBe(401);
    const [entry] = (await auditOf(test.db, someone.id)).filter(
      (row) => row.action === 'customer.sessions_revoked_by_admin',
    );
    expect(entry?.details).toEqual({ count: 1 });
  });
});

describe('notes and history (SN2, CS4)', () => {
  it('keeps one pinned note, archives notes and audits without the body', async () => {
    const someone = await customer();
    const add = async (body: string, pinned: boolean) =>
      json<{ id: string; pinned: boolean }>(
        await client.post(`/api/admin/customers/${someone.id}/notes`, {
          cookie: admin.cookie,
          body: { body, pinned },
        }),
        201,
      );
    const first = await add('عميل موثوق', true);
    const second = await add('ملاحظة ثانية', true);
    const notes = await json<{ items: { id: string; pinned: boolean }[] }>(
      await adminGet(`/api/admin/customers/${someone.id}/notes`),
      200,
    );
    expect(notes.items).toEqual([
      expect.objectContaining({ id: second.id, pinned: true }),
      expect.objectContaining({ id: first.id, pinned: false }),
    ]);
    const read = await json<{ pinnedNote: { id: string } }>(await profile(someone.id), 200);
    expect(read.pinnedNote.id).toBe(second.id);
    await json(
      await client.post(`/api/admin/customers/${someone.id}/notes/${first.id}/archive`, {
        cookie: admin.cookie,
      }),
      200,
    );
    const archived = await json<{ items: { id: string }[] }>(
      await adminGet(`/api/admin/customers/${someone.id}/notes?archived=true`),
      200,
    );
    expect(archived.items.map((note) => note.id)).toEqual([first.id]);
    const other = await customer();
    expect(
      (
        await client.post(`/api/admin/customers/${other.id}/notes/${second.id}/unpin`, {
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(404);
    const entries = await auditOf(test.db, someone.id);
    expect(JSON.stringify(entries.map((entry) => entry.details))).not.toContain('عميل موثوق');
    const history = await json<{ items: { action: string }[] }>(
      await adminGet(`/api/admin/customers/${someone.id}/history`),
      200,
    );
    expect(history.items.map((item) => item.action)).toEqual(
      expect.arrayContaining(['customer.note_added', 'customer.note_archived']),
    );
  });
});
