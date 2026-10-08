import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { DEPOSIT_SETTINGS_DEFAULTS, UPLOAD_MAX_BYTES } from '@vertex-digital/contracts';
import {
  auditEntries,
  depositFlags,
  depositReceipts,
  deposits,
  ledgerAccounts,
  ledgerJournals,
  ledgerPostings,
  newId,
  storedFiles,
  storeSwitchChanges,
} from '@vertex-digital/db';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
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
 * Sham Cash deposits (S03, F05) over HTTP against the test database. Deposit settings and rates
 * are global and append-only: this file saves its own settings and rate first. Customers have
 * their own phone numbers, so the shared-phone flag (FL5) is raised only where a test wants it.
 * Rates exist in the test database once any run set one, so `RATE_UNAVAILABLE` at creation is
 * left to the options rule (`no_rate`) and the contracts tests.
 */

const USD = 1_000_000;

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
/** An admin session without a recent re-authentication. */
let plainAdmin: string;
let rateId: string;
const seeded: string[] = [];

/** A random image, so no receipt of an earlier run matches it (FL1, FL2). */
async function image(format: 'png' | 'jpeg' | 'webp' = 'png'): Promise<Buffer> {
  const raw = randomBytes(32 * 32 * 3);
  const pipeline = sharp(raw, { raw: { width: 32, height: 32, channels: 3 } });
  return format === 'png'
    ? pipeline.png().toBuffer()
    : format === 'jpeg'
      ? pipeline.jpeg().toBuffer()
      : pipeline.webp({ lossless: true }).toBuffer();
}

const form = (file: Buffer, name = 'receipt.png', fields: Record<string, string> = {}) => {
  const data = new FormData();
  data.set('file', new Blob([new Uint8Array(file)]), name);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

async function reauthenticate(cookie = admin.cookie) {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

async function customer() {
  const seededCustomer = await seedCustomer(test.db, { phone: uniquePhone() });
  seeded.push(seededCustomer.id);
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

const create = async (
  cookie: string,
  input: { currency: 'SYP' | 'USD'; amountUnits: number },
  key: string = randomUUID(),
) =>
  client.post('/api/deposits/sham-cash', {
    cookie,
    body: input,
    headers: { 'idempotency-key': key, ...(await client.altcha()) },
  });

async function created(cookie: string, input: { currency: 'SYP' | 'USD'; amountUnits: number }) {
  const response = await create(cookie, input);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Record<string, unknown> & {
    id: string;
    quote: { rateId: string } | null;
  };
}

const submit = async (cookie: string, id: string, file?: Buffer, fields?: Record<string, string>) =>
  client.post(`/api/deposits/${id}/receipt`, {
    cookie,
    form: form(file ?? (await image()), 'r.png', fields),
  });

/** A deposit with its receipt, ready for review. */
async function submitted(
  cookie: string,
  input: { currency: 'SYP' | 'USD'; amountUnits: number },
  file?: Buffer,
) {
  const deposit = await created(cookie, input);
  const response = await submit(
    cookie,
    deposit.id,
    file,
    deposit.quote ? { rateId: deposit.quote.rateId } : {},
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown> & { id: string };
}

const transactionNumber = () => `TX-${randomUUID().slice(0, 13)}`;

const approve = (
  id: string,
  input: Record<string, unknown>,
  options: { cookie?: string; key?: string } = {},
) =>
  client.post(`/api/admin/deposits/${id}/approve`, {
    cookie: options.cookie ?? admin.cookie,
    body: { referenceCheck: 'matches', acknowledgedFlags: [], ...input },
    headers: { 'idempotency-key': options.key ?? randomUUID() },
  });

const reject = (id: string, input: Record<string, unknown>, key = randomUUID()) =>
  client.post(`/api/admin/deposits/${id}/reject`, {
    cookie: admin.cookie,
    body: input,
    headers: { 'idempotency-key': key },
  });

async function uploadQr(): Promise<string> {
  const response = await client.post('/api/admin/deposit-settings/qr', {
    cookie: admin.cookie,
    form: form(await image()),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { fileId: string }).fileId;
}

const settingsInput = {
  ...DEPOSIT_SETTINGS_DEFAULTS,
  shamCashAccountName: 'Vertex Digital',
  shamCashAccountNumber: '0933000000',
};

async function saveSettings(input: Record<string, unknown>) {
  const response = await client.request('PUT', '/api/admin/deposit-settings', {
    cookie: admin.cookie,
    body: input,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

const journalsOf = (depositId: string) =>
  test.db
    .select({ id: ledgerJournals.id })
    .from(ledgerJournals)
    .where(eq(ledgerJournals.idempotencyKey, `deposit:${depositId}`));

/** The deposit emails queued to an address: sign-in emails go to the same address. */
const depositEmails = async (address: string) =>
  (await emailsTo(test.db, address)).filter((email) =>
    email.template.startsWith('customer_deposit'),
  );

const actionsOf = async (depositId: string) =>
  (await auditOf(test.db, depositId)).map((entry) => entry.action);

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  await reauthenticate();
  const rate = await client.post('/api/admin/rates', {
    cookie: admin.cookie,
    body: { sypPerUsd: '118', displayStepSypUnits: 500, rateConfirmation: '118' },
  });
  expect(rate.status).toBe(201);
  rateId = ((await rate.json()) as { id: string }).id;
  await saveSettings({
    ...settingsInput,
    sypEnabled: true,
    usdEnabled: true,
    sypQrFileId: await uploadQr(),
    usdQrFileId: await uploadQr(),
  });
});

afterAll(async () => {
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session, and keeps customer and admin routes apart', async () => {
    const someone = await customer();
    const id = newId();
    const customerRoutes: [string, string][] = [
      ['GET', '/api/deposits/sham-cash/options'],
      ['GET', '/api/deposits/sham-cash/qr/SYP'],
      ['POST', '/api/deposits/sham-cash'],
      ['GET', '/api/deposits'],
      ['GET', `/api/deposits/${id}`],
      ['POST', `/api/deposits/${id}/quote`],
      ['POST', `/api/deposits/${id}/receipt`],
      ['POST', `/api/deposits/${id}/cancel`],
    ];
    const adminRoutes: [string, string][] = [
      ['GET', '/api/admin/deposit-settings'],
      ['PUT', '/api/admin/deposit-settings'],
      ['POST', '/api/admin/deposit-settings/qr'],
      ['GET', `/api/admin/deposit-settings/qr/${id}`],
      ['GET', '/api/admin/deposits'],
      ['GET', '/api/admin/deposits/counts'],
      ['GET', `/api/admin/deposits/${id}`],
      ['GET', `/api/admin/deposits/${id}/receipts/${id}`],
      ['POST', `/api/admin/deposits/${id}/approve`],
      ['POST', `/api/admin/deposits/${id}/reject`],
      ['POST', `/api/admin/deposits/${id}/request-receipt`],
    ];
    for (const [method, path] of customerRoutes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: admin.cookie })).status, path).toBe(401);
    }
    for (const [method, path] of adminRoutes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: someone.cookie })).status, path).toBe(
        401,
      );
    }
  });

  it('never caches deposit answers (rule SC15)', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    for (const response of [
      await client.get('/api/deposits/sham-cash/options', { cookie: someone.cookie }),
      await client.get(`/api/deposits/${deposit.id}`, { cookie: someone.cookie }),
      await client.get('/api/deposits', { cookie: someone.cookie }),
      await client.get(`/api/admin/deposits/${deposit.id}`, { cookie: admin.cookie }),
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const qr = await client.get('/api/deposits/sham-cash/qr/USD', { cookie: someone.cookie });
    expect(qr.status).toBe(200);
    expect(qr.headers.get('content-type')).toBe('image/png');
    expect(qr.headers.get('cache-control')).toBe('private, max-age=300');
    expect(qr.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('deposit settings', () => {
  it('reads the settings in force, and needs a re-authentication to save or upload', async () => {
    const read = await client.get('/api/admin/deposit-settings', { cookie: plainAdmin });
    expect(await read.json()).toMatchObject({ saved: true, shamCashAccountName: 'Vertex Digital' });
    const save = await client.request('PUT', '/api/admin/deposit-settings', {
      cookie: plainAdmin,
      body: settingsInput,
    });
    expect(await body(save)).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    const upload = await client.post('/api/admin/deposit-settings/qr', {
      cookie: plainAdmin,
      form: form(await image()),
    });
    expect(await body(upload)).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
  });

  it('refuses a currency enabled without its QR, or an unknown QR image', async () => {
    const missing = await client.request('PUT', '/api/admin/deposit-settings', {
      cookie: admin.cookie,
      body: { ...settingsInput, sypEnabled: true },
    });
    expect(await body(missing)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const unknown = await client.request('PUT', '/api/admin/deposit-settings', {
      cookie: admin.cookie,
      body: { ...settingsInput, sypEnabled: true, sypQrFileId: newId() },
    });
    expect(await body(unknown)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('re-encodes a QR image to PNG and serves it to the admin', async () => {
    const fileId = await uploadQr();
    const [row] = await test.db.select().from(storedFiles).where(eq(storedFiles.id, fileId));
    expect(row).toMatchObject({ kind: 'sham_cash_qr', contentType: 'image/png' });
    const served = await client.get(`/api/admin/deposit-settings/qr/${fileId}`, {
      cookie: admin.cookie,
    });
    expect(served.status).toBe(200);
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format).toBe('png');
    expect(
      (await client.get(`/api/admin/deposit-settings/qr/${newId()}`, { cookie: admin.cookie }))
        .status,
    ).toBe(404);
  });

  it('refuses a QR upload that is not an image or is too large', async () => {
    const pdf = await client.post('/api/admin/deposit-settings/qr', {
      cookie: admin.cookie,
      form: form(Buffer.from('%PDF-1.7\n1 0 obj\n'), 'qr.pdf'),
    });
    expect(await body(pdf)).toMatchObject({ status: 400, code: 'RECEIPT_INVALID' });
    const large = await client.post('/api/admin/deposit-settings/qr', {
      cookie: admin.cookie,
      form: form(Buffer.alloc(UPLOAD_MAX_BYTES + 1), 'qr.png'),
    });
    expect(await body(large)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('audits a save with the changed fields only', async () => {
    const before = (await (
      await client.get('/api/admin/deposit-settings', { cookie: admin.cookie })
    ).json()) as Record<string, unknown>;
    const { saved: _, savedAt: __, ...current } = before;
    await saveSettings({ ...current, reviewTargetMinutes: 20 });
    await saveSettings({ ...current, reviewTargetMinutes: 15 });
    const [entry] = await test.db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.action, 'deposit_settings.changed'))
      .orderBy(sql`${auditEntries.occurredAt} desc`)
      .limit(1);
    expect(entry?.details).toMatchObject({
      before: { reviewTargetMinutes: 20 },
      after: { reviewTargetMinutes: 15 },
    });
  });
});

describe('the options (rules SC1, SC3, SC13)', () => {
  it('tells the wizard what is available, the limits, the rate and the review time', async () => {
    const someone = await customer();
    const response = await client.get('/api/deposits/sham-cash/options', {
      cookie: someone.cookie,
    });
    expect(await response.json()).toMatchObject({
      state: 'available',
      currencies: {
        SYP: { available: true, reason: null },
        USD: { available: true, reason: null },
      },
      account: { name: 'Vertex Digital', number: '0933000000' },
      limits: {
        established: false,
        minUnits: 2 * USD,
        perDepositUnits: 50 * USD,
        dailyUnits: 100 * USD,
        remainingTodayUnits: 100 * USD,
      },
      rate: { id: rateId, sypPerUsd: '118', displayStepSypUnits: 500 },
      reviewHours: { start: '10:00', end: '22:00' },
      eta: expect.objectContaining({ state: expect.stringMatching(/open|closed/) }),
      pendingDepositId: null,
    });
  });
});

describe('creating a deposit (rules SC2–SC6)', () => {
  it('quotes a SYP deposit for 15 minutes and converts it down to whole cents', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'SYP', amountUnits: 200_000 });
    expect(deposit).toMatchObject({
      status: 'pending',
      method: 'sham_cash',
      referenceCode: expect.stringMatching(/^VD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/),
      currency: 'SYP',
      declaredAmountUnits: 200_000,
      declaredUsdUnits: 16_940_000,
      quote: { rateId, rate: '118' },
      rateFixed: false,
      payTo: {
        accountName: 'Vertex Digital',
        accountNumber: '0933000000',
        qrUrl: '/api/deposits/sham-cash/qr/SYP',
      },
      eta: null,
    });
    const [quote] = await test.db
      .select({ minutes: sql<number>`extract(epoch from quote_expires_at - created_at) / 60` })
      .from(deposits)
      .where(eq(deposits.id, deposit.id));
    expect(Math.round(Number(quote?.minutes))).toBe(15);
    expect(await actionsOf(deposit.id)).toEqual(['deposit.created']);
  });

  it('replays the same key and body, and refuses the key with another body', async () => {
    const someone = await customer();
    const key = randomUUID();
    const input = { currency: 'USD', amountUnits: 5 * USD } as const;
    const first = await create(someone.cookie, input, key);
    expect(first.status).toBe(201);
    const again = await create(someone.cookie, input, key);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id,
    );
    const other = await create(someone.cookie, { ...input, amountUnits: 6 * USD }, key);
    expect(await body(other)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('creates one deposit for one key sent in parallel', async () => {
    const someone = await customer();
    const key = randomUUID();
    const responses = await Promise.all(
      [1, 2, 3].map(() => create(someone.cookie, { currency: 'USD', amountUnits: 5 * USD }, key)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
    const rows = await test.db
      .select({ id: deposits.id })
      .from(deposits)
      .where(eq(deposits.customerId, someone.id));
    expect(rows).toHaveLength(1);
  });

  it('keeps one pending deposit per customer and names it (rule SC4)', async () => {
    const someone = await customer();
    const first = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const second = await create(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    expect(await body(second)).toMatchObject({
      status: 409,
      code: 'DEPOSIT_ALREADY_PENDING',
      details: { depositId: first.id },
    });
    const options = await client.get('/api/deposits/sham-cash/options', { cookie: someone.cookie });
    expect(await options.json()).toMatchObject({ pendingDepositId: first.id });
  });

  it('enforces the minimum, the per-deposit and the daily limits (rule SC3)', async () => {
    const someone = await customer();
    expect(
      await body(await create(someone.cookie, { currency: 'USD', amountUnits: 1 * USD })),
    ).toMatchObject({
      status: 422,
      code: 'DEPOSIT_LIMIT_EXCEEDED',
      details: { limit: 'minimum', limitUnits: 2 * USD, remainingUnits: 100 * USD },
    });
    expect(
      await body(await create(someone.cookie, { currency: 'USD', amountUnits: 60 * USD })),
    ).toMatchObject({ details: { limit: 'per_deposit', limitUnits: 50 * USD } });
    await submitted(someone.cookie, { currency: 'USD', amountUnits: 50 * USD });
    await submitted(someone.cookie, { currency: 'USD', amountUnits: 40 * USD });
    expect(
      await body(await create(someone.cookie, { currency: 'USD', amountUnits: 20 * USD })),
    ).toMatchObject({
      status: 422,
      details: { limit: 'daily', limitUnits: 100 * USD, remainingUnits: 10 * USD },
    });
  });

  it('allows at most 3 deposits in review (rule SC5)', async () => {
    const someone = await customer();
    for (let count = 0; count < 3; count += 1) {
      await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    }
    expect(
      await body(await create(someone.cookie, { currency: 'USD', amountUnits: 5 * USD })),
    ).toMatchObject({ status: 409, code: 'TOO_MANY_DEPOSITS_IN_REVIEW' });
  });

  it('allows 10 creations an hour per customer (rule SC6)', async () => {
    const someone = await customer();
    for (let count = 0; count < 10; count += 1) {
      const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 2 * USD });
      await client.post(`/api/deposits/${deposit.id}/cancel`, { cookie: someone.cookie });
    }
    expect(
      await body(await create(someone.cookie, { currency: 'USD', amountUnits: 2 * USD })),
    ).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });

  it('refuses a disabled currency, a fraction of a pound and no ALTCHA', async () => {
    const someone = await customer();
    expect(
      await body(await create(someone.cookie, { currency: 'SYP', amountUnits: 200_050 })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const noAltcha = await client.post('/api/deposits/sham-cash', {
      cookie: someone.cookie,
      body: { currency: 'USD', amountUnits: 5 * USD },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(await body(noAltcha)).toMatchObject({ code: 'ALTCHA_REQUIRED' });
    const current = (await (
      await client.get('/api/admin/deposit-settings', { cookie: admin.cookie })
    ).json()) as Record<string, unknown>;
    const { saved: _, savedAt: __, ...values } = current;
    await saveSettings({ ...values, sypEnabled: false });
    try {
      expect(
        await body(await create(someone.cookie, { currency: 'SYP', amountUnits: 200_000 })),
      ).toMatchObject({ status: 409, code: 'DEPOSIT_METHOD_UNAVAILABLE' });
      const options = await client.get('/api/deposits/sham-cash/options', {
        cookie: someone.cookie,
      });
      expect(await options.json()).toMatchObject({
        currencies: { SYP: { available: false, reason: 'disabled' } },
      });
    } finally {
      await saveSettings(values);
    }
  });
});

describe('the customer reads only their own deposits', () => {
  it('answers 404 for a deposit of another customer, on every route', async () => {
    const owner = await customer();
    const other = await customer();
    const deposit = await created(owner.cookie, { currency: 'SYP', amountUnits: 100_000 });
    for (const [method, path] of [
      ['GET', `/api/deposits/${deposit.id}`],
      ['POST', `/api/deposits/${deposit.id}/quote`],
      ['POST', `/api/deposits/${deposit.id}/cancel`],
    ] as const) {
      expect(
        await body(await client.request(method, path, { cookie: other.cookie })),
      ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    expect(await body(await submit(other.cookie, deposit.id))).toMatchObject({ status: 404 });
    const list = (await (await client.get('/api/deposits', { cookie: other.cookie })).json()) as {
      items: unknown[];
    };
    expect(list.items).toEqual([]);
    const own = (await (await client.get('/api/deposits', { cookie: owner.cookie })).json()) as {
      items: { id: string }[];
    };
    expect(own.items.map((item) => item.id)).toEqual([deposit.id]);
  });
});

describe('quotes (rules SC9, SC10)', () => {
  it('refuses a receipt after the quote expired, offers the current rate, and accepts after a requote', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'SYP', amountUnits: 200_000 });
    await test.db
      .update(deposits)
      .set({ quoteExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(deposits.id, deposit.id));
    const refused = await submit(someone.cookie, deposit.id, undefined, { rateId });
    expect(await body(refused)).toMatchObject({
      status: 409,
      code: 'QUOTE_EXPIRED',
      details: { rateId, rate: '118', declaredUsdUnits: 16_940_000 },
    });
    const requoted = await client.post(`/api/deposits/${deposit.id}/quote`, {
      cookie: someone.cookie,
    });
    expect(requoted.status).toBe(200);
    expect(await requoted.json()).toMatchObject({
      declaredAmountUnits: 200_000,
      quote: { rateId },
    });
    const accepted = await submit(someone.cookie, deposit.id, undefined, { rateId });
    expect(await accepted.json()).toMatchObject({
      status: 'submitted',
      rateFixed: true,
      eta: expect.any(Object),
    });
    expect(await actionsOf(deposit.id)).toEqual([
      'deposit.created',
      'deposit.requoted',
      'deposit.submitted',
    ]);
  });

  it('refuses a receipt that carries a rate the customer did not see', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'SYP', amountUnits: 200_000 });
    const response = await submit(someone.cookie, deposit.id, undefined, { rateId: newId() });
    expect(await body(response)).toMatchObject({ status: 409, code: 'QUOTE_EXPIRED' });
    const without = await submit(someone.cookie, deposit.id);
    expect(await body(without)).toMatchObject({ status: 409, code: 'QUOTE_EXPIRED' });
  });

  it('refuses a requote of a USD deposit or a fixed rate', async () => {
    const someone = await customer();
    const usd = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const refused = await client.post(`/api/deposits/${usd.id}/quote`, { cookie: someone.cookie });
    expect(await body(refused)).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
      details: { status: 'pending' },
    });
    await client.post(`/api/deposits/${usd.id}/cancel`, { cookie: someone.cookie });
    const syp = await submitted(someone.cookie, { currency: 'SYP', amountUnits: 100_000 });
    const fixed = await client.post(`/api/deposits/${syp.id}/quote`, { cookie: someone.cookie });
    expect(await body(fixed)).toMatchObject({ status: 409, code: 'DEPOSIT_STATE_CONFLICT' });
  });
});

describe('receipts (rule SC8)', () => {
  it('stores a re-encoded WebP without metadata, with its hashes', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const jpeg = await sharp(await image())
      .jpeg()
      .withExif({ IFD0: { Copyright: 'Somebody' }, IFD3: { GPSLatitudeRef: 'N' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    // A JPEG named .png: accepted by its content.
    const response = await submit(someone.cookie, deposit.id, jpeg);
    expect(response.status).toBe(200);
    const [receipt] = await test.db
      .select()
      .from(depositReceipts)
      .where(eq(depositReceipts.depositId, deposit.id));
    expect(receipt?.originalSha256).toHaveLength(32);
    const served = await client.get(`/api/admin/deposits/${deposit.id}/receipts/${receipt?.id}`, {
      cookie: admin.cookie,
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    expect(served.headers.get('content-type')).toBe('image/webp');
    const metadata = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(
      (
        await client.get(`/api/admin/deposits/${deposit.id}/receipts/${newId()}`, {
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('refuses a PDF, a decompression bomb and an oversized file', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const pdf = await submit(someone.cookie, deposit.id, Buffer.from('%PDF-1.7\n%âãÏÓ\n'));
    expect(await body(pdf)).toMatchObject({ status: 400, code: 'RECEIPT_INVALID' });
    // A 1×1 PNG whose header claims 50,000 × 50,000 pixels.
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    png.writeUInt32BE(50_000, 16);
    png.writeUInt32BE(50_000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);
    const bomb = await submit(someone.cookie, deposit.id, png);
    expect(await body(bomb)).toMatchObject({ status: 400, code: 'RECEIPT_INVALID' });
    const large = await submit(someone.cookie, deposit.id, Buffer.alloc(UPLOAD_MAX_BYTES + 1));
    expect(await body(large)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    const missing = await client.post(`/api/deposits/${deposit.id}/receipt`, {
      cookie: someone.cookie,
      form: new FormData(),
    });
    expect(await body(missing)).toMatchObject({ status: 400, code: 'RECEIPT_INVALID' });
    const [row] = await test.db.select().from(deposits).where(eq(deposits.id, deposit.id));
    expect(row?.status).toBe('pending');
  });

  it('refuses a receipt on a deposit past its expiry, even before the worker (edge case 19)', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    await test.db
      .update(deposits)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(deposits.id, deposit.id));
    expect(await body(await submit(someone.cookie, deposit.id))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
      details: { status: 'expired' },
    });
  });

  it('counts every upload, refused or not, and writes no file for a refused one (rule SC6)', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    await client.post(`/api/deposits/${deposit.id}/cancel`, { cookie: someone.cookie });
    const files = () =>
      readdir(resolve(process.env.FILES_ROOT as string), { recursive: true }).catch(() => []);
    const before = (await files()).length;
    for (let count = 0; count < 20; count += 1) {
      expect((await submit(someone.cookie, deposit.id)).status).toBe(409);
    }
    expect((await files()).length).toBe(before);
    expect(await body(await submit(someone.cookie, deposit.id))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('settles a receipt racing the expiry with one outcome (rule SC12)', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const [submission, expired] = await Promise.all([
      submit(someone.cookie, deposit.id),
      test.db
        .update(deposits)
        .set({ status: 'expired' })
        .where(and(eq(deposits.id, deposit.id), eq(deposits.status, 'pending')))
        .returning({ id: deposits.id }),
    ]);
    const [row] = await test.db.select().from(deposits).where(eq(deposits.id, deposit.id));
    if (expired.length === 1) {
      expect(await body(submission)).toMatchObject({ code: 'DEPOSIT_STATE_CONFLICT' });
      expect(row?.status).toBe('expired');
    } else {
      expect(submission.status).toBe(200);
      expect(row?.status).toBe('submitted');
    }
  });

  it('cancels a pending deposit only (rule SC11)', async () => {
    const someone = await customer();
    const deposit = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const cancelled = await client.post(`/api/deposits/${deposit.id}/cancel`, {
      cookie: someone.cookie,
    });
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', payTo: null });
    const again = await client.post(`/api/deposits/${deposit.id}/cancel`, {
      cookie: someone.cookie,
    });
    expect(await body(again)).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
      details: { status: 'cancelled' },
    });
    expect(await actionsOf(deposit.id)).toEqual(['deposit.created', 'deposit.cancelled']);
  });
});

describe('the store switches (S05 rules SW4–SW6)', () => {
  it('shows the method paused or stopped, and refuses only new deposits', async () => {
    const someone = await customer();
    const existing = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const options = async () =>
      (await (
        await client.get('/api/deposits/sham-cash/options', { cookie: someone.cookie })
      ).json()) as { state: string; currencies: { USD: { available: boolean } } };
    const other = await customer();
    try {
      await setSwitches(test.db, { sham_cash_paused: true });
      expect(await options()).toMatchObject({
        state: 'paused',
        currencies: { USD: { available: true } },
      });
      expect(
        await body(await create(other.cookie, { currency: 'USD', amountUnits: 5 * USD })),
      ).toMatchObject({
        status: 409,
        code: 'DEPOSITS_STOPPED',
        details: { reason: 'method_paused' },
      });

      await setSwitches(test.db, { sham_cash_paused: true, deposits_stopped: true });
      expect((await options()).state).toBe('stopped');
      expect(
        await body(await create(other.cookie, { currency: 'USD', amountUnits: 5 * USD })),
      ).toMatchObject({ status: 409, code: 'DEPOSITS_STOPPED', details: { reason: 'emergency' } });

      // A deposit that already exists goes on: its receipt, then the admin's approval (SW4).
      const receipt = await submit(someone.cookie, existing.id);
      expect(receipt.status, await receipt.clone().text()).toBe(200);
      const approved = await approve(existing.id, {
        transactionNumber: transactionNumber(),
        receivedCurrency: 'USD',
        receivedAmountUnits: 5 * USD,
      });
      expect(approved.status, await approved.clone().text()).toBe(200);
    } finally {
      await setSwitches(test.db);
    }
    expect((await options()).state).toBe('available');
    const after = await create(other.cookie, { currency: 'USD', amountUnits: 5 * USD });
    expect(after.status).toBe(201);
  });

  it('replays a creation made before the stop', async () => {
    const someone = await customer();
    const key = randomUUID();
    const input = { currency: 'USD' as const, amountUnits: 5 * USD };
    expect((await create(someone.cookie, input, key)).status).toBe(201);
    try {
      await setSwitches(test.db, { deposits_stopped: true });
      expect((await create(someone.cookie, input, key)).status).toBe(200);
    } finally {
      await setSwitches(test.db);
    }
  });

  it('makes a creation wait for a stop being written, then sees it (rule SW5)', async () => {
    const someone = await customer();
    let answer: Promise<Response> | undefined;
    await test.db.transaction(async (tx) => {
      // What `SettingsService.change` does, held open while the customer creates a deposit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings'))`);
      await tx.insert(storeSwitchChanges).values({
        id: newId(),
        switch: 'deposits_stopped',
        value: true,
        adminId: newId(),
        channel: 'admin',
      });
      answer = create(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
      const settled = await Promise.race([
        answer.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 500)),
      ]);
      expect(settled).toBe('waiting');
    });
    try {
      expect(await body(await (answer as Promise<Response>))).toMatchObject({
        status: 409,
        code: 'DEPOSITS_STOPPED',
      });
      const [pending] = await test.db
        .select({ id: deposits.id })
        .from(deposits)
        .where(eq(deposits.customerId, someone.id));
      expect(pending).toBeUndefined();
    } finally {
      await setSwitches(test.db);
    }
  });
});

describe('fraud flags (rules FL1–FL5)', () => {
  const flagsOf = async (depositId: string) =>
    (await test.db.select().from(depositFlags).where(eq(depositFlags.depositId, depositId))).map(
      (flag) => flag.code,
    );

  it('flags a reused receipt with the other deposit and a similar one', async () => {
    const first = await customer();
    const second = await customer();
    const raw = randomBytes(32 * 32 * 3);
    const pixels = { raw: { width: 32, height: 32, channels: 3 } } as const;
    const png = await sharp(raw, pixels).png().toBuffer();
    // The same pixels in other bytes: a different hash, the same picture.
    const recompressed = await sharp(raw, pixels).png({ compressionLevel: 0 }).toBuffer();
    const original = await submitted(first.cookie, { currency: 'USD', amountUnits: 5 * USD }, png);
    const reused = await submitted(second.cookie, { currency: 'USD', amountUnits: 5 * USD }, png);
    const [flag] = await test.db
      .select()
      .from(depositFlags)
      .where(and(eq(depositFlags.depositId, reused.id), eq(depositFlags.code, 'receipt_reused')));
    expect(flag?.details).toMatchObject({
      matches: [{ depositId: original.id, customerId: first.id }],
    });
    const third = await customer();
    const similar = await submitted(
      third.cookie,
      { currency: 'USD', amountUnits: 5 * USD },
      recompressed,
    );
    expect(await flagsOf(similar.id)).toEqual(['receipt_similar']);
    expect(await flagsOf(original.id)).toEqual([]);
  });

  it('flags a large deposit of a new account (FL3)', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 25 * USD });
    expect(await flagsOf(deposit.id)).toEqual(['new_account_large']);
  });

  it('flags the fourth submission in 24 hours (FL4)', async () => {
    const someone = await customer();
    const ids: string[] = [];
    for (let count = 0; count < 3; count += 1) {
      ids.push((await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD })).id);
    }
    const rejected = await reject(ids[0] as string, {
      reason: 'not_received',
      internalNote: 'Nothing arrived',
    });
    expect(rejected.status).toBe(200);
    const fourth = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    expect(await flagsOf(fourth.id)).toEqual(['velocity']);
    expect(await flagsOf(ids[2] as string)).toEqual([]);
  });

  it('flags a phone another customer has (FL5)', async () => {
    const phone = uniquePhone();
    const first = await seedCustomer(test.db, { phone });
    const second = await seedCustomer(test.db, { phone });
    seeded.push(first.id, second.id);
    const cookie = await client.signInCustomer(second.email);
    const deposit = await submitted(cookie, { currency: 'USD', amountUnits: 5 * USD });
    const [flag] = await test.db
      .select()
      .from(depositFlags)
      .where(eq(depositFlags.depositId, deposit.id));
    expect(flag).toMatchObject({
      code: 'shared_phone',
      details: { count: 1, customerIds: [first.id] },
    });
    // The customer never sees flags.
    const view = await client.get(`/api/deposits/${deposit.id}`, { cookie });
    expect(JSON.stringify(await view.json())).not.toMatch(/shared_phone|flag/);
  });
});

describe('the review queue (rule RV10)', () => {
  it('lists flagged deposits first, then the oldest, with a cursor, and counts them', async () => {
    const plain = await customer();
    const large = await customer();
    const older = await submitted(plain.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const flagged = await submitted(large.cookie, { currency: 'USD', amountUnits: 30 * USD });
    const page = async (query: string) =>
      (await (
        await client.get(`/api/admin/deposits${query}`, { cookie: admin.cookie })
      ).json()) as { items: { id: string; flags: string[] }[]; nextCursor: string | null };
    const all: { id: string; flags: string[] }[] = [];
    let cursor: string | null = null;
    do {
      const result = await page(`?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      all.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    const ids = all.map((item) => item.id);
    expect(ids.indexOf(flagged.id)).toBeLessThan(ids.indexOf(older.id));
    const firstUnflagged = all.findIndex((item) => item.flags.length === 0);
    expect(all.slice(firstUnflagged).every((item) => item.flags.length === 0)).toBe(true);
    expect(all.find((item) => item.id === flagged.id)?.flags).toEqual(['new_account_large']);
    const small = await page('?limit=1');
    expect(small.items).toHaveLength(1);
    const next = await page(`?limit=1&cursor=${small.nextCursor}`);
    expect(next.items[0]?.id).toBe(ids[1]);
    const byCode = await page(
      `?status=all&q=${(flagged as unknown as { referenceCode: string }).referenceCode.toLowerCase()}`,
    );
    expect(byCode.items.map((item) => item.id)).toEqual([flagged.id]);
    const byEmail = await page(`?status=all&q=${plain.email.slice(0, 20)}`);
    expect(byEmail.items.map((item) => item.id)).toEqual([older.id]);
    const unflagged = await page('?flagged=false&limit=100');
    expect(unflagged.items.every((item) => item.flags.length === 0)).toBe(true);
    const counts = await client.get('/api/admin/deposits/counts', { cookie: admin.cookie });
    expect(await counts.json()).toMatchObject({
      submitted: expect.any(Number),
      submittedFlagged: expect.any(Number),
      pending: expect.any(Number),
    });
  });

  it('shows the admin the deposit, its receipts, flags and customer', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'SYP', amountUnits: 200_000 });
    const response = await client.get(`/api/admin/deposits/${deposit.id}`, {
      cookie: admin.cookie,
    });
    expect(await response.json()).toMatchObject({
      id: deposit.id,
      status: 'submitted',
      rateFixedAt: expect.any(String),
      approvalRate: { rateId, rate: '118' },
      receipts: [{ id: expect.any(String) }],
      flags: [],
      credit: null,
      customer: {
        id: someone.id,
        established: false,
        creditedCount: 0,
        creditedTotalUsdUnits: 0,
        balanceUnits: 0,
        recentDeposits: [],
      },
      eta: expect.any(Object),
    });
    expect(
      await body(await client.get(`/api/admin/deposits/${newId()}`, { cookie: admin.cookie })),
    ).toMatchObject({ status: 404 });
  });
});

describe('approving (rules RV1–RV5, RV7, RV9, M1–M3)', () => {
  it('credits SYP received in four postings balanced per currency, with its email', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'SYP', amountUnits: 200_000 });
    // 1,900 SYP received: the mismatch flag needs a re-authentication (rule RV4).
    const input = {
      transactionNumber: transactionNumber(),
      receivedCurrency: 'SYP',
      receivedAmountUnits: 190_000,
      acknowledgedFlags: ['amount_mismatch'],
    };
    expect(await body(await approve(deposit.id, input, { cookie: plainAdmin }))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    const response = await approve(deposit.id, input);
    expect(response.status).toBe(200);
    const credited = (await response.json()) as {
      credit: { journalId: string };
      flags: { code: string }[];
    };
    expect(credited).toMatchObject({
      status: 'credited',
      adminName: expect.any(String),
      credit: {
        transactionNumber: input.transactionNumber,
        receivedCurrency: 'SYP',
        receivedAmountUnits: 190_000,
        creditedUsdUnits: 16_100_000,
        creditRateId: rateId,
        creditRate: '118',
        referenceCheck: 'matches',
      },
      customer: { balanceUnits: 16_100_000 },
    });
    expect(credited.flags.map((flag) => flag.code)).toEqual(['amount_mismatch']);
    const postings = await test.db
      .select({
        code: ledgerAccounts.code,
        currency: ledgerPostings.currency,
        amountUnits: ledgerPostings.amountUnits,
      })
      .from(ledgerPostings)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerPostings.accountId))
      .where(eq(ledgerPostings.journalId, credited.credit.journalId))
      .orderBy(ledgerPostings.position);
    expect(postings).toEqual([
      { code: 'sham_cash_receipts:SYP', currency: 'SYP', amountUnits: -190_000 },
      { code: 'currency_exchange:SYP', currency: 'SYP', amountUnits: 190_000 },
      { code: 'currency_exchange:USD', currency: 'USD', amountUnits: -16_100_000 },
      { code: `customer_wallet:${someone.id}`, currency: 'USD', amountUnits: 16_100_000 },
    ]);
    const [email] = await depositEmails(someone.email);
    expect(email).toMatchObject({ template: 'customer_deposit_credited' });
    expect((await notificationsOf(test.db, someone.id)).map((item) => item.event)).toEqual([
      'deposit_credited',
    ]);
    expect(JSON.stringify(email?.params)).not.toContain(input.transactionNumber);
    // The wallet timeline shows the deposit with its pounds and rate (S02 rule W5).
    const entries = (await (
      await client.get('/api/wallet/entries', { cookie: someone.cookie })
    ).json()) as { items: { deposit: unknown }[] };
    expect(entries.items[0]?.deposit).toEqual({
      method: 'sham_cash',
      referenceCode: (deposit as unknown as { referenceCode: string }).referenceCode,
      syp: { amountUnits: 190_000, rate: '118' },
    });
    const view = await client.get(`/api/deposits/${deposit.id}`, { cookie: someone.cookie });
    expect(await view.json()).toMatchObject({
      status: 'credited',
      credited: { usdUnits: 16_100_000, receivedCurrency: 'SYP', rate: '118' },
    });
  });

  it('needs no re-authentication for $100.00 unflagged, and needs one at $100.01', async () => {
    const someone = await customer();
    // Established first: a credited deposit lifts the limits and the new-account flag.
    const first = await submitted(someone.cookie, { currency: 'USD', amountUnits: 10 * USD });
    const firstCredit = await approve(
      first.id,
      {
        transactionNumber: transactionNumber(),
        receivedCurrency: 'USD',
        receivedAmountUnits: 10 * USD,
      },
      { cookie: plainAdmin },
    );
    expect(firstCredit.status).toBe(200);
    const hundred = await submitted(someone.cookie, { currency: 'USD', amountUnits: 100 * USD });
    const approved = await approve(
      hundred.id,
      {
        transactionNumber: transactionNumber(),
        receivedCurrency: 'USD',
        receivedAmountUnits: 100 * USD,
      },
      { cookie: plainAdmin },
    );
    expect(approved.status).toBe(200);
    const more = await submitted(someone.cookie, {
      currency: 'USD',
      amountUnits: 100 * USD + 10_000,
    });
    const refused = await approve(
      more.id,
      {
        transactionNumber: transactionNumber(),
        receivedCurrency: 'USD',
        receivedAmountUnits: 100 * USD + 10_000,
      },
      { cookie: plainAdmin },
    );
    expect(await body(refused)).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
  });

  it('needs every flag acknowledged, and a reference check flag of its own (rule RV5)', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 30 * USD });
    const input = {
      transactionNumber: transactionNumber(),
      receivedCurrency: 'USD',
      receivedAmountUnits: 30 * USD,
      referenceCheck: 'missing',
    };
    const refused = await approve(deposit.id, {
      ...input,
      acknowledgedFlags: ['new_account_large'],
    });
    expect(await body(refused)).toMatchObject({
      status: 409,
      code: 'FLAGS_NOT_ACKNOWLEDGED',
      details: { expected: ['new_account_large', 'reference_missing'] },
    });
    const approved = await approve(deposit.id, {
      ...input,
      acknowledgedFlags: ['reference_missing', 'new_account_large'],
    });
    expect(approved.status).toBe(200);
  });

  it('replays the same key and body, and refuses the key with another body', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const key = randomUUID();
    const input = {
      transactionNumber: transactionNumber(),
      receivedCurrency: 'USD',
      receivedAmountUnits: 5 * USD,
    };
    expect((await approve(deposit.id, input, { key })).status).toBe(200);
    expect((await approve(deposit.id, input, { key })).status).toBe(200);
    expect(
      await body(await approve(deposit.id, { ...input, receivedAmountUnits: 4 * USD }, { key })),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await body(await approve(deposit.id, input))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
      details: { status: 'credited' },
    });
    expect(await journalsOf(deposit.id)).toHaveLength(1);
    expect((await depositEmails(someone.email)).length).toBe(1);
  });

  it('credits once when two approvals race (edge case 6)', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const input = {
      transactionNumber: transactionNumber(),
      receivedCurrency: 'USD',
      receivedAmountUnits: 5 * USD,
    };
    const responses = await Promise.all([approve(deposit.id, input), approve(deposit.id, input)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await journalsOf(deposit.id)).toHaveLength(1);
    expect(
      (await actionsOf(deposit.id)).filter((action) => action === 'deposit.credited'),
    ).toHaveLength(1);
    expect((await depositEmails(someone.email)).length).toBe(1);
  });

  it('credits one of two deposits approved at once with one transaction number (edge case 7)', async () => {
    const first = await customer();
    const second = await customer();
    const a = await submitted(first.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const b = await submitted(second.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const number = transactionNumber();
    const input = {
      transactionNumber: number,
      receivedCurrency: 'USD',
      receivedAmountUnits: 5 * USD,
    };
    const responses = await Promise.all([approve(a.id, input), approve(b.id, input)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const refused = responses.find((response) => response.status === 409) as Response;
    expect(await body(refused)).toMatchObject({
      code: 'EXTERNAL_REFERENCE_TAKEN',
      details: { kind: 'deposit' },
    });
    const journals = [...(await journalsOf(a.id)), ...(await journalsOf(b.id))];
    expect(journals).toHaveLength(1);
  });

  it('lets one of a deposit and a manual adjustment claim a transfer (rule SC14)', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const number = transactionNumber();
    const [approval, adjustment] = await Promise.all([
      approve(deposit.id, {
        transactionNumber: number,
        receivedCurrency: 'USD',
        receivedAmountUnits: 5 * USD,
      }),
      client.post(`/api/admin/wallets/${someone.id}/adjustments`, {
        cookie: admin.cookie,
        body: {
          direction: 'credit',
          amountUnits: 5 * USD,
          category: 'manual_deposit',
          reason: 'A second transfer',
          depositMethod: 'sham_cash',
          externalReference: ` ${number.toLowerCase()} `,
        },
        headers: { 'idempotency-key': randomUUID() },
      }),
    ]);
    expect([approval.status === 200, adjustment.status === 201].filter(Boolean)).toHaveLength(1);
    const loser = approval.status === 200 ? adjustment : approval;
    expect(await body(loser)).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_TAKEN' });
  });

  it('leaves nothing behind when the transaction number is taken (rule RV7)', async () => {
    const first = await customer();
    const second = await customer();
    const taken = await submitted(first.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const number = transactionNumber();
    expect(
      (
        await approve(taken.id, {
          transactionNumber: number,
          receivedCurrency: 'USD',
          receivedAmountUnits: 5 * USD,
        })
      ).status,
    ).toBe(200);
    const deposit = await submitted(second.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const refused = await approve(deposit.id, {
      transactionNumber: number,
      receivedCurrency: 'USD',
      receivedAmountUnits: 4 * USD,
      acknowledgedFlags: ['amount_mismatch'],
    });
    expect(await body(refused)).toMatchObject({
      status: 409,
      code: 'EXTERNAL_REFERENCE_TAKEN',
      details: { kind: 'deposit', id: taken.id },
    });
    expect(await journalsOf(deposit.id)).toEqual([]);
    const flags = await test.db
      .select()
      .from(depositFlags)
      .where(eq(depositFlags.depositId, deposit.id));
    expect(flags).toEqual([]);
    expect(await actionsOf(deposit.id)).toEqual(['deposit.created', 'deposit.submitted']);
    expect(await depositEmails(second.email)).toEqual([]);
    const [row] = await test.db.select().from(deposits).where(eq(deposits.id, deposit.id));
    expect(row?.status).toBe('submitted');
  });

  it('refuses a credit below one cent, a deposit not in review and an unknown deposit', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const tiny = await approve(deposit.id, {
      transactionNumber: transactionNumber(),
      receivedCurrency: 'SYP',
      receivedAmountUnits: 100,
      acknowledgedFlags: ['amount_mismatch'],
    });
    expect(await body(tiny)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const pending = await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    expect(
      await body(
        await approve(pending.id, {
          transactionNumber: transactionNumber(),
          receivedCurrency: 'USD',
          receivedAmountUnits: 5 * USD,
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
      details: { status: 'pending' },
    });
    expect(
      await body(
        await approve(newId(), {
          transactionNumber: transactionNumber(),
          receivedCurrency: 'USD',
          receivedAmountUnits: 5 * USD,
        }),
      ),
    ).toMatchObject({ status: 404 });
  });

  it('converts SYP received on a USD deposit at the current rate (rule RV3)', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const response = await approve(deposit.id, {
      transactionNumber: transactionNumber(),
      receivedCurrency: 'SYP',
      receivedAmountUnits: 59_000,
      acknowledgedFlags: ['amount_mismatch'],
    });
    expect(await response.json()).toMatchObject({
      credit: { creditedUsdUnits: 5 * USD, creditRateId: rateId, creditRate: '118' },
    });
  });
});

describe('rejecting (rule RV6) and asking for a clearer receipt (rule RV8)', () => {
  it('rejects with a reason and a note for the customer, never in the email', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const noNote = await reject(deposit.id, { reason: 'other', internalNote: 'Checked it' });
    expect(await body(noNote)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const key = randomUUID();
    const input = {
      reason: 'receipt_invalid',
      customerNote: 'الصورة غير واضحة',
      internalNote: 'Edited image',
    };
    expect((await reject(deposit.id, input, key)).status).toBe(200);
    expect((await reject(deposit.id, input, key)).status).toBe(200);
    expect(
      await body(await reject(deposit.id, { ...input, reason: 'not_received' }, key)),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await body(await reject(deposit.id, input))).toMatchObject({
      status: 409,
      code: 'DEPOSIT_STATE_CONFLICT',
    });
    const view = await client.get(`/api/deposits/${deposit.id}`, { cookie: someone.cookie });
    expect(await view.json()).toMatchObject({
      status: 'rejected',
      rejection: { reason: 'receipt_invalid', note: 'الصورة غير واضحة' },
    });
    const emails = await depositEmails(someone.email);
    expect(emails.map((email) => email.template)).toEqual(['customer_deposit_rejected']);
    expect(await notificationsOf(test.db, someone.id)).toEqual([
      {
        event: 'deposit_rejected',
        params: {
          depositId: deposit.id,
          referenceCode: expect.any(String),
          reason: 'receipt_invalid',
        },
        readAt: null,
      },
    ]);
    expect(JSON.stringify(emails[0]?.params)).not.toContain('الصورة');
    const [entry] = (await auditOf(test.db, deposit.id)).filter(
      (item) => item.action === 'deposit.rejected',
    );
    expect(entry?.reason).toBe('Edited image');
    expect(await body(await reject(newId(), input))).toMatchObject({ status: 404 });
  });

  it('asks once for a clearer receipt, and the second receipt is reviewed at the fixed rate', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'SYP', amountUnits: 100_000 });
    const request = (input: Record<string, unknown>) =>
      client.post(`/api/admin/deposits/${deposit.id}/request-receipt`, {
        cookie: plainAdmin,
        body: input,
      });
    const response = await request({ customerNote: 'صورة أوضح من فضلك', internalNote: 'Blurred' });
    expect(await response.json()).toMatchObject({ status: 'pending', receiptRequestCount: 1 });
    const view = (await (
      await client.get(`/api/deposits/${deposit.id}`, { cookie: someone.cookie })
    ).json()) as { receiptRequest: unknown; rateFixed: boolean };
    expect(view).toMatchObject({
      receiptRequest: { note: 'صورة أوضح من فضلك' },
      rateFixed: true,
    });
    // The quote may have expired since: a fixed rate needs none (rule SC9).
    await test.db
      .update(deposits)
      .set({ expiresAt: sql`now() + interval '24 hours'` })
      .where(eq(deposits.id, deposit.id));
    expect((await submit(someone.cookie, deposit.id)).status).toBe(200);
    expect(await body(await request({ internalNote: 'Still blurred' }))).toMatchObject({
      status: 409,
      code: 'RECEIPT_ALREADY_REQUESTED',
    });
    const detail = (await (
      await client.get(`/api/admin/deposits/${deposit.id}`, { cookie: admin.cookie })
    ).json()) as { receipts: unknown[] };
    expect(detail.receipts).toHaveLength(2);
    expect((await depositEmails(someone.email)).map((email) => email.template)).toEqual([
      'customer_deposit_receipt_requested',
    ]);
    expect((await notificationsOf(test.db, someone.id)).map((item) => item.event)).toEqual([
      'deposit_receipt_requested',
    ]);
  });

  it('refuses to send a deposit back while the customer has another pending (edge case 9)', async () => {
    const someone = await customer();
    const deposit = await submitted(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    await created(someone.cookie, { currency: 'USD', amountUnits: 5 * USD });
    const response = await client.post(`/api/admin/deposits/${deposit.id}/request-receipt`, {
      cookie: admin.cookie,
      body: { internalNote: 'Blurred image' },
    });
    expect(await body(response)).toMatchObject({ status: 409, code: 'DEPOSIT_ALREADY_PENDING' });
    const [row] = await test.db.select().from(deposits).where(eq(deposits.id, deposit.id));
    expect(row?.status).toBe('submitted');
    const notInReview = await client.post(`/api/admin/deposits/${newId()}/request-receipt`, {
      cookie: admin.cookie,
      body: { internalNote: 'Blurred image' },
    });
    expect(notInReview.status).toBe(404);
  });
});
