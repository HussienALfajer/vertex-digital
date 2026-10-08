import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DEPOSIT_SETTINGS_DEFAULTS } from '@vertex-digital/contracts';
import {
  deposits,
  ledgerJournals,
  telegramLinks,
  telegramMessages,
  telegramPrompts,
} from '@vertex-digital/db';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
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
 * Deposit decisions from Telegram (S05 rules TC1, TC4–TC6, edge cases 3–5) over HTTP against the
 * test database: Sham Cash deposits submitted by customers, decided by tapping the bot's buttons
 * and answering its questions through the webhook. The USDT cases are in `deposits-usdt.test.ts`.
 * The file saves its own deposit settings, links its own chat and leaves the bot unlinked.
 */

const SECRET = 'test-webhook-secret-0123456789abcdef';
const USD = 1_000_000;

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

const owner = (() => {
  const id = 7_000_000_000 + randomInt(1_000_000_000);
  return { chat: { id, type: 'private' }, from: { id, username: `owner${id}` } };
})();

let nextUpdateId = Date.now() * 1000 + 500_000;
const updateId = () => {
  nextUpdateId += 1;
  return nextUpdateId;
};

const webhook = (payload: unknown) =>
  fetch(`${test.url}/api/webhooks/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify(payload),
  });

const sendText = async (text: string) => {
  const response = await webhook({
    update_id: updateId(),
    message: { message_id: 1, from: owner.from, chat: owner.chat, text },
  });
  expect(response.status).toBe(200);
};

/** Presses a button; resolves with the inline answer's text, if any. */
const tap = async (data: string, id = updateId()): Promise<string | undefined> => {
  const response = await webhook({
    update_id: id,
    callback_query: {
      id: `q${id}`,
      from: owner.from,
      message: { message_id: 2, chat: owner.chat },
      data,
    },
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return text ? (JSON.parse(text) as { text?: string }).text : undefined;
};

const lastReply = async () =>
  (
    await test.db
      .select({ params: telegramMessages.params })
      .from(telegramMessages)
      .where(eq(telegramMessages.chatId, owner.chat.id))
      .orderBy(asc(telegramMessages.createdAt), asc(telegramMessages.id))
  ).at(-1)?.params as Record<string, unknown> | undefined;

/** The open prompt's id (rule TG7). */
const openPromptId = async () => {
  const [prompt] = await test.db
    .select({ id: telegramPrompts.id })
    .from(telegramPrompts)
    .where(isNull(telegramPrompts.closedAt));
  return prompt?.id;
};

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

async function image(): Promise<Buffer> {
  return sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();
}

const form = (file: Buffer) => {
  const data = new FormData();
  data.set('file', new Blob([new Uint8Array(file)]), 'receipt.png');
  return data;
};

async function saveSettings(changes: Record<string, unknown> = {}) {
  const qr = async () => {
    const response = await client.post('/api/admin/deposit-settings/qr', {
      cookie: admin.cookie,
      form: form(await image()),
    });
    return ((await response.json()) as { fileId: string }).fileId;
  };
  await reauthenticate();
  const response = await client.request('PUT', '/api/admin/deposit-settings', {
    cookie: admin.cookie,
    body: {
      ...DEPOSIT_SETTINGS_DEFAULTS,
      shamCashAccountName: 'Vertex Digital',
      shamCashAccountNumber: '0933000000',
      usdEnabled: true,
      usdQrFileId: await qr(),
      ...changes,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function customer() {
  const seededCustomer = await seedCustomer(test.db, { phone: uniquePhone() });
  seeded.push(seededCustomer.id);
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

/** A USD Sham Cash deposit with its receipt, `submitted` (rule TC1). */
async function submitted(dollars: number, someone?: Awaited<ReturnType<typeof customer>>) {
  const by = someone ?? (await customer());
  const created = await client.post('/api/deposits/sham-cash', {
    cookie: by.cookie,
    body: { currency: 'USD', amountUnits: dollars * USD },
    headers: { 'idempotency-key': randomUUID(), ...(await client.altcha()) },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const receipt = await client.post(`/api/deposits/${id}/receipt`, {
    cookie: by.cookie,
    form: form(await image()),
  });
  expect(receipt.status, await receipt.clone().text()).toBe(200);
  return { id, customer: by };
}

const depositRow = async (id: string) =>
  (await test.db.select().from(deposits).where(eq(deposits.id, id)))[0];

const journalsOf = (depositId: string) =>
  test.db
    .select({ id: ledgerJournals.id })
    .from(ledgerJournals)
    .where(eq(ledgerJournals.idempotencyKey, `deposit:${depositId}`));

const cardJobs = async (depositId: string) =>
  (
    await test.db.execute<{ count: number }>(
      sql`select count(*)::int as count from pgboss.job
        where name = 'telegram.deposit-card' and data->>'depositId' = ${depositId}`,
    )
  ).rows[0]?.count ?? 0;

/** "اعتماد", the transaction number, then the confirmation's prompt id (rule TC4). */
async function askToApprove(depositId: string, number: string): Promise<string> {
  expect(await tap(`ap:${depositId}`)).toBeUndefined();
  expect(await lastReply()).toMatchObject({ reply: 'approve_number' });
  await sendText(number);
  const reply = await lastReply();
  expect(reply).toMatchObject({ reply: 'approve_confirm', transactionNumber: number.trim() });
  return reply?.promptId as string;
}

const transactionNumber = () => `TG-${randomUUID().slice(0, 12)}`;

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await reauthenticate();
  const rate = await client.post('/api/admin/rates', {
    cookie: admin.cookie,
    body: { sypPerUsd: '118', displayStepSypUnits: 500, rateConfirmation: '118' },
  });
  expect(rate.status).toBe(201);
  await saveSettings();
  await test.db
    .update(telegramLinks)
    .set({ unlinkedAt: new Date() })
    .where(isNull(telegramLinks.unlinkedAt));
  const code = await client.post('/api/admin/telegram/link-code', { cookie: admin.cookie });
  const { deepLink } = (await code.json()) as { deepLink: string };
  await sendText(`/start ${new URL(deepLink).searchParams.get('start')}`);
  expect(await lastReply()).toEqual({ reply: 'welcome' });
});

afterAll(async () => {
  await test.db
    .update(telegramLinks)
    .set({ unlinkedAt: new Date() })
    .where(isNull(telegramLinks.unlinkedAt));
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('approval from Telegram (rule TC4)', () => {
  it('credits through the panel service, with the channel telegram', async () => {
    const { id, customer: by } = await submitted(20);
    // The submission queued its card (rule TC1).
    expect(await cardJobs(id)).toBe(1);
    const number = String(randomInt(10_000_000, 99_999_999));
    const promptId = await askToApprove(id, ` ${number} `);
    expect(await lastReply()).toMatchObject({
      referenceCode: expect.any(String),
      creditedUsdUnits: 20 * USD,
    });
    expect(await tap(`ok:${promptId}`)).toBeUndefined();
    expect(await lastReply()).toMatchObject({ reply: 'approved', creditedUsdUnits: 20 * USD });
    expect(await depositRow(id)).toMatchObject({
      status: 'credited',
      transactionNumber: number,
      receivedCurrency: 'USD',
      receivedAmountUnits: 20 * USD,
      creditedUsdUnits: 20 * USD,
      referenceCheck: 'matches',
      decidedBy: 'admin',
      adminId: admin.id,
      decisionIdempotencyKey: promptId,
    });
    expect(await journalsOf(id)).toHaveLength(1);
    const credited = (await auditOf(test.db, id)).find(
      (entry) => entry.action === 'deposit.credited',
    );
    expect(credited).toMatchObject({ channel: 'telegram', actorId: admin.id, ipAddress: null });
    expect((await notificationsOf(test.db, by.id)).map((row) => row.event)).toEqual([
      'deposit_credited',
    ]);
    expect(
      (await emailsTo(test.db, by.email)).filter(
        (email) => email.template === 'customer_deposit_credited',
      ),
    ).toHaveLength(1);
    // The decision queued the card's edit (rule TC6): one queued job per deposit.
    expect(await cardJobs(id)).toBeGreaterThanOrEqual(1);
    // The same confirmation again, or its redelivery: nothing more.
    expect(await tap(`ok:${promptId}`)).toMatch(/انتهت/);
    expect(await journalsOf(id)).toHaveLength(1);
  });

  it('credits once when a Telegram confirmation races a panel approval', async () => {
    const { id, customer: by } = await submitted(15);
    const number = transactionNumber();
    const promptId = await askToApprove(id, number);
    const [, panel] = await Promise.all([
      tap(`ok:${promptId}`),
      client.post(`/api/admin/deposits/${id}/approve`, {
        cookie: admin.cookie,
        body: {
          transactionNumber: number,
          receivedCurrency: 'USD',
          receivedAmountUnits: 15 * USD,
          referenceCheck: 'matches',
          acknowledgedFlags: [],
        },
        headers: { 'idempotency-key': randomUUID() },
      }),
    ]);
    expect([200, 409]).toContain(panel.status);
    expect(await journalsOf(id)).toHaveLength(1);
    const actions = (await auditOf(test.db, id)).map((entry) => entry.action);
    expect(actions.filter((action) => action === 'deposit.credited')).toHaveLength(1);
    expect(await notificationsOf(test.db, by.id)).toHaveLength(1);
    expect(
      (await emailsTo(test.db, by.email)).filter(
        (email) => email.template === 'customer_deposit_credited',
      ),
    ).toHaveLength(1);
    // Whichever lost was told: the panel by its 409, Telegram by "تم البت فيه مسبقاً".
    const reply = await lastReply();
    if (panel.status === 200) expect(reply).toMatchObject({ refusal: 'decided' });
    else expect(reply).toMatchObject({ reply: 'approved' });
  });

  it('credits once when the same confirmation is delivered twice at once', async () => {
    const { id } = await submitted(12);
    const promptId = await askToApprove(id, transactionNumber());
    await Promise.all([tap(`ok:${promptId}`), tap(`ok:${promptId}`)]);
    expect(await journalsOf(id)).toHaveLength(1);
    expect((await depositRow(id))?.status).toBe('credited');
  });

  it('refuses a flagged deposit, one over the limit, and every approval at limit 0', async () => {
    // A new account's deposit of $25 or more is flagged (S03 rule FL3).
    const flagged = await submitted(30);
    expect(await tap(`ap:${flagged.id}`)).toMatch(/علامات/);
    expect(await openPromptId()).toBeUndefined();
    await saveSettings({ telegramApprovalMaxUsdUnits: 10 * USD });
    const over = await submitted(11);
    expect(await tap(`ap:${over.id}`)).toMatch(/فوق حد تيليجرام/);
    await saveSettings({ telegramApprovalMaxUsdUnits: 0 });
    expect(await tap(`ap:${over.id}`)).toMatch(/متوقف/);
    await saveSettings();
    expect((await depositRow(over.id))?.status).toBe('submitted');
  });

  it('re-checks the limit at the confirmation (edge case 5)', async () => {
    const { id } = await submitted(20);
    const promptId = await askToApprove(id, transactionNumber());
    await saveSettings({ telegramApprovalMaxUsdUnits: 10 * USD });
    await tap(`ok:${promptId}`);
    expect(await lastReply()).toMatchObject({ reply: 'decision_refused', refusal: 'over_limit' });
    expect((await depositRow(id))?.status).toBe('submitted');
    await saveSettings();
  });

  it('refuses a deposit decided in the panel meanwhile (edge case 3)', async () => {
    const { id } = await submitted(9);
    const promptId = await askToApprove(id, transactionNumber());
    const rejected = await client.post(`/api/admin/deposits/${id}/reject`, {
      cookie: admin.cookie,
      body: { reason: 'not_received', internalNote: 'Checked the account' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(rejected.status).toBe(200);
    await tap(`ok:${promptId}`);
    expect(await lastReply()).toMatchObject({ reply: 'decision_refused', refusal: 'decided' });
    expect(await journalsOf(id)).toHaveLength(0);
    // A button on the old card meets the same check.
    expect(await tap(`ap:${id}`)).toMatch(/البت فيه/);
  });

  it('refuses a deposit resubmitted after a clearer-receipt request (edge case 4)', async () => {
    const { id, customer: by } = await submitted(8);
    const promptId = await askToApprove(id, transactionNumber());
    const requested = await client.post(`/api/admin/deposits/${id}/request-receipt`, {
      cookie: admin.cookie,
      body: { internalNote: 'The image is blurred' },
    });
    expect(requested.status, await requested.clone().text()).toBe(200);
    const again = await client.post(`/api/deposits/${id}/receipt`, {
      cookie: by.cookie,
      form: form(await image()),
    });
    expect(again.status).toBe(200);
    await tap(`ok:${promptId}`);
    expect(await lastReply()).toMatchObject({ reply: 'decision_refused', refusal: 'changed' });
    expect((await depositRow(id))?.status).toBe('submitted');
  });

  it('refuses a resubmission made before the transaction number was sent (edge case 4)', async () => {
    const { id, customer: by } = await submitted(6);
    expect(await tap(`ap:${id}`)).toBeUndefined();
    const requested = await client.post(`/api/admin/deposits/${id}/request-receipt`, {
      cookie: admin.cookie,
      body: { internalNote: 'The image is blurred' },
    });
    expect(requested.status).toBe(200);
    const again = await client.post(`/api/deposits/${id}/receipt`, {
      cookie: by.cookie,
      form: form(await image()),
    });
    expect(again.status).toBe(200);
    await sendText(transactionNumber());
    expect(await lastReply()).toMatchObject({ reply: 'decision_refused', refusal: 'changed' });
    expect(await openPromptId()).toBeUndefined();
    expect((await depositRow(id))?.status).toBe('submitted');
  });

  it('answers a transaction number already recorded', async () => {
    const first = await submitted(5);
    const second = await submitted(6);
    const number = transactionNumber();
    await tap(`ok:${await askToApprove(first.id, number)}`);
    await tap(`ok:${await askToApprove(second.id, number)}`);
    expect(await lastReply()).toMatchObject({
      reply: 'decision_refused',
      refusal: 'reference_taken',
    });
    expect((await depositRow(second.id))?.status).toBe('submitted');
  });

  it('asks again for a transaction number that is not one', async () => {
    const { id } = await submitted(4);
    await tap(`ap:${id}`);
    await sendText('x'.repeat(65));
    expect(await lastReply()).toEqual({ reply: 'invalid_answer', field: 'transaction_number' });
    expect(await openPromptId()).toBeDefined();
    await tap(`no:${await openPromptId()}`);
  });
});

describe('rejection from Telegram (rule TC5)', () => {
  it('rejects with a reason button and the internal note', async () => {
    const { id, customer: by } = await submitted(7);
    expect(await tap(`rj:${id}`)).toBeUndefined();
    const reasons = await lastReply();
    expect(reasons).toMatchObject({
      reply: 'reject_reasons',
      reasons: [
        'not_received',
        'receipt_invalid',
        'receipt_used',
        'reference_other_customer',
        'wrong_account',
      ],
    });
    const promptId = reasons?.promptId as string;
    // Text before a reason: the reasons again.
    await sendText('too early');
    expect(await lastReply()).toMatchObject({ reply: 'reject_reasons', promptId });
    // `other` needs a customer note: never a button.
    expect(await tap(`rr:${promptId}:other`)).toBeUndefined();
    await tap(`rr:${promptId}:not_received`);
    expect(await lastReply()).toMatchObject({ reply: 'reject_note', reason: 'not_received' });
    await sendText('abc');
    expect(await lastReply()).toEqual({ reply: 'invalid_answer', field: 'note' });
    await sendText('لم يصل التحويل إلى الحساب');
    expect(await lastReply()).toMatchObject({ reply: 'rejected', reason: 'not_received' });
    expect(await depositRow(id)).toMatchObject({
      status: 'rejected',
      rejectReason: 'not_received',
      customerNote: null,
      decisionIdempotencyKey: promptId,
    });
    const rejected = (await auditOf(test.db, id)).find(
      (entry) => entry.action === 'deposit.rejected',
    );
    expect(rejected).toMatchObject({ channel: 'telegram', reason: 'لم يصل التحويل إلى الحساب' });
    expect((await notificationsOf(test.db, by.id)).map((row) => row.event)).toEqual([
      'deposit_rejected',
    ]);
    // A flagged deposit is rejected from Telegram too: it moves no money.
    const flagged = await submitted(40);
    await tap(`rj:${flagged.id}`);
    expect(await lastReply()).toMatchObject({ reply: 'reject_reasons' });
    await tap(`no:${await openPromptId()}`);
  });
});

describe('deposit settings (rule TC4)', () => {
  it('save the Telegram limit and audit it', async () => {
    const saved = await saveSettings({ telegramApprovalMaxUsdUnits: 50 * USD });
    expect(saved).toMatchObject({ telegramApprovalMaxUsdUnits: 50 * USD });
    const refused = await client.request('PUT', '/api/admin/deposit-settings', {
      cookie: admin.cookie,
      body: { ...saved, telegramApprovalMaxUsdUnits: 101 * USD },
    });
    expect(refused.status).toBe(400);
    await saveSettings();
  });
});
