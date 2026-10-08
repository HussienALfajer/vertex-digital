import { randomBytes, randomInt } from 'node:crypto';
import {
  auditEntries,
  newId,
  storeSwitchChanges,
  telegramLinkCodes,
  telegramLinks,
  telegramMessages,
  telegramPrompts,
} from '@vertex-digital/db';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENV, type Env } from '../src/core/config/env.js';
import { SettingsService } from '../src/modules/settings/index.js';
import { linkCodeDigest } from '../src/modules/telegram/telegram.service.js';
import {
  api,
  auditOf,
  body,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The Telegram admin bot (S05 F07, rules TG1–TG7, AL2, AL4) over HTTP against the test database.
 * Telegram is played by posting updates to the webhook with the secret; the bot's answers are
 * outbox rows (the worker sends them), read here by this file's own chat ids. The file leaves the
 * switches at their defaults and the bot unlinked.
 */

const SECRET = 'test-webhook-secret-0123456789abcdef';

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

/** A Telegram user in a private chat: the chat id is the user id. */
const telegramUser = () => {
  const id = 6_000_000_000 + randomInt(1_000_000_000);
  return { id, chat: { id, type: 'private' }, from: { id, username: `owner${id}` } };
};

let nextUpdateId = Date.now() * 1000;
const updateId = () => {
  nextUpdateId += 1;
  return nextUpdateId;
};

const webhook = (payload: unknown, secret: string | null = SECRET) =>
  fetch(`${test.url}/api/webhooks/telegram`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret !== null && { 'x-telegram-bot-api-secret-token': secret }),
    },
    body: JSON.stringify(payload),
  });

type User = ReturnType<typeof telegramUser>;

const sendText = (user: User, text: string, chat = user.chat, id = updateId()) =>
  webhook({ update_id: id, message: { message_id: 1, from: user.from, chat, text } });

const tap = (user: User, data: string, id = updateId()) =>
  webhook({
    update_id: id,
    callback_query: {
      id: `q${id}`,
      from: user.from,
      message: { message_id: 2, chat: user.chat },
      data,
    },
  });

/** The bot replies queued for a chat, oldest first. */
const repliesTo = (chatId: number) =>
  test.db
    .select({ kind: telegramMessages.kind, params: telegramMessages.params })
    .from(telegramMessages)
    .where(eq(telegramMessages.chatId, chatId))
    .orderBy(asc(telegramMessages.createdAt), asc(telegramMessages.id));

const lastReply = async (chatId: number) => (await repliesTo(chatId)).at(-1)?.params;

async function reauthenticatedAdmin() {
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
}

async function linkCode(): Promise<string> {
  const response = await client.post('/api/admin/telegram/link-code', { cookie: admin.cookie });
  expect(response.status).toBe(201);
  const { deepLink } = (await response.json()) as { deepLink: string };
  return new URL(deepLink).searchParams.get('start') ?? '';
}

/** Links `user` through the deep link, as the owner does (rule TG3). */
async function linkAs(user: User): Promise<void> {
  expect((await sendText(user, `/start ${await linkCode()}`)).status).toBe(200);
  expect(await lastReply(user.chat.id)).toEqual({ reply: 'welcome' });
}

const liveLink = async () =>
  (await test.db.select().from(telegramLinks).where(isNull(telegramLinks.unlinkedAt)))[0];

const unlinkAll = () =>
  test.db
    .update(telegramLinks)
    .set({ unlinkedAt: new Date() })
    .where(isNull(telegramLinks.unlinkedAt));

const switchValue = async (name: 'purchases_stopped' | 'deposits_stopped') => {
  const [row] = await test.db
    .select()
    .from(storeSwitchChanges)
    .where(eq(storeSwitchChanges.switch, name))
    .orderBy(desc(storeSwitchChanges.createdAt), desc(storeSwitchChanges.id))
    .limit(1);
  return row;
};

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  await unlinkAll();
  await reauthenticatedAdmin();
});

afterAll(async () => {
  await setSwitches(test.db);
  await unlinkAll();
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session and to a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    for (const options of [{}, { cookie }]) {
      expect((await client.get('/api/admin/telegram', options)).status).toBe(401);
      expect((await client.post('/api/admin/telegram/link-code', options)).status).toBe(401);
      expect((await client.delete('/api/admin/telegram/link', options)).status).toBe(401);
      expect((await client.post('/api/admin/telegram/test', options)).status).toBe(401);
    }
  });

  it('needs a re-authentication to create a link code or unlink (rule TG3)', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    for (const response of [
      await client.post('/api/admin/telegram/link-code', { cookie: fresh.cookie }),
      await client.delete('/api/admin/telegram/link', { cookie: fresh.cookie }),
    ]) {
      expect(await body(response)).toMatchObject({
        status: 403,
        code: 'REAUTHENTICATION_REQUIRED',
      });
    }
    // The fresh admin replaced the one of this file (there is only one): restore it.
    await reauthenticatedAdmin();
  });

  it('refuses the webhook without the secret, or with a wrong one, with no body (rule TG4)', async () => {
    const user = telegramUser();
    for (const secret of [null, 'wrong', `${SECRET}x`, '']) {
      const response = await webhook(
        {
          update_id: updateId(),
          message: { message_id: 1, from: user.from, chat: user.chat, text: '/help' },
        },
        secret,
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
    }
    expect(await repliesTo(user.chat.id)).toEqual([]);
  });

  it('refuses a webhook body over 64 KB', async () => {
    const response = await webhook({ update_id: updateId(), padding: 'x'.repeat(70 * 1024) });
    expect(response.status).toBe(413);
  });

  it('answers 200 and ignores an update it cannot read', async () => {
    for (const payload of [{}, { update_id: 'x' }, { update_id: updateId(), poll: { id: '1' } }]) {
      const response = await webhook(payload);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
  });

  it('is off while the bot is not configured (rule TG1)', async () => {
    const env = test.app.get<Env>(ENV);
    const username = env.TELEGRAM_BOT_USERNAME;
    env.TELEGRAM_BOT_USERNAME = undefined;
    try {
      expect(
        await body(await client.get('/api/admin/telegram', { cookie: admin.cookie })),
      ).toMatchObject({
        status: 200,
        configured: false,
      });
      for (const response of [
        await client.post('/api/admin/telegram/link-code', { cookie: admin.cookie }),
        await client.post('/api/admin/telegram/test', { cookie: admin.cookie }),
      ]) {
        expect(await body(response)).toMatchObject({
          status: 409,
          code: 'TELEGRAM_NOT_CONFIGURED',
        });
      }
      expect((await sendText(telegramUser(), '/help')).status).toBe(401);
    } finally {
      env.TELEGRAM_BOT_USERNAME = username;
    }
  });
});

describe('linking (rule TG3)', () => {
  it('creates a single-use code, stores only its digest and audits it without the code', async () => {
    const before = new Date();
    const response = await client.post('/api/admin/telegram/link-code', { cookie: admin.cookie });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { deepLink, expiresAt } = (await response.json()) as {
      deepLink: string;
      expiresAt: string;
    };
    const code = new URL(deepLink).searchParams.get('start') ?? '';
    expect(deepLink).toBe(`https://t.me/vertex_test_bot?start=${code}`);
    expect(code).toMatch(/^[\w-]{22}$/);
    expect(new Date(expiresAt).getTime() - before.getTime()).toBeGreaterThan(9 * 60 * 1000);
    const [row] = await test.db
      .select()
      .from(telegramLinkCodes)
      .where(eq(telegramLinkCodes.codeSha256, linkCodeDigest(code)));
    expect(row).toMatchObject({ adminId: admin.id, usedAt: null });
    const [entry] = await auditOf(test.db, row?.id ?? '');
    expect(entry).toMatchObject({
      action: 'telegram.link_code_created',
      actorId: admin.id,
      channel: 'admin',
      details: { expiresAt },
    });
    expect(JSON.stringify(entry)).not.toContain(code);
  });

  it('links a private chat with /start <code>, then shows it in the panel', async () => {
    await unlinkAll();
    const user = telegramUser();
    await linkAs(user);
    const link = await liveLink();
    expect(link).toMatchObject({
      adminId: admin.id,
      chatId: user.chat.id,
      telegramUserId: user.from.id,
      telegramUsername: user.from.username,
    });
    const [entry] = await auditOf(test.db, link?.id ?? '');
    expect(entry).toMatchObject({
      action: 'telegram.linked',
      actorKind: 'admin',
      actorId: admin.id,
      channel: 'telegram',
      details: { telegramUserId: user.from.id, previousLinkId: null },
    });
    const status = await body(await client.get('/api/admin/telegram', { cookie: admin.cookie }));
    expect(status).toMatchObject({
      status: 200,
      configured: true,
      link: { username: user.from.username, since: link?.linkedAt.toISOString() },
    });
  });

  it('refuses a used, wrong or expired code with one generic reply', async () => {
    const user = telegramUser();
    const code = await linkCode();
    await linkAs({ ...user });
    const stranger = telegramUser();
    // Used (by `linkAs` with a fresh code, then this one twice).
    await sendText(stranger, `/start ${code}`);
    await sendText(stranger, `/start ${code}`);
    await sendText(stranger, '/start not-a-code');
    await sendText(stranger, `/start ${'A'.repeat(22)}`);
    const expired = randomBytes(16).toString('base64url');
    await test.db.insert(telegramLinkCodes).values({
      id: newId(),
      adminId: admin.id,
      codeSha256: linkCodeDigest(expired),
      expiresAt: new Date(Date.now() - 1000),
    });
    await sendText(stranger, `/start ${expired}`);
    const replies = await repliesTo(stranger.chat.id);
    // The first use of `code` linked the stranger; every later attempt is refused.
    expect(replies.map((reply) => reply.params)).toEqual([
      { reply: 'welcome' },
      ...Array(4).fill({ reply: 'invalid_code' }),
    ]);
    expect((await liveLink())?.chatId).toBe(stranger.chat.id);
  });

  it('ignores /start <code> from a group chat', async () => {
    const user = telegramUser();
    const code = await linkCode();
    const group = { id: -1_000_000_000_000 - randomInt(1_000_000), type: 'supergroup' };
    await sendText(user, `/start ${code}`, group);
    expect(await repliesTo(group.id)).toEqual([]);
    expect((await liveLink())?.chatId).not.toBe(group.id);
  });

  it('a new link ends the previous one and tells its chat', async () => {
    const first = telegramUser();
    await linkAs(first);
    const previous = await liveLink();
    const second = telegramUser();
    await linkAs(second);
    const live = await liveLink();
    expect(live?.chatId).toBe(second.chat.id);
    const [old] = await test.db
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.id, previous?.id ?? ''));
    expect(old?.unlinkedAt).toBeInstanceOf(Date);
    expect((await repliesTo(first.chat.id)).at(-1)).toEqual({ kind: 'link_changed', params: {} });
    const [entry] = await auditOf(test.db, live?.id ?? '');
    expect(entry?.details).toMatchObject({ previousLinkId: previous?.id });
    // The previous chat is no longer obeyed.
    await sendText(first, '/status');
    expect((await repliesTo(first.chat.id)).at(-1)?.kind).toBe('link_changed');
  });

  it('handles a redelivered update once (rule TG5)', async () => {
    const user = telegramUser();
    const code = await linkCode();
    const id = updateId();
    const [a, b] = await Promise.all([
      sendText(user, `/start ${code}`, user.chat, id),
      sendText(user, `/start ${code}`, user.chat, id),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await sendText(user, `/start ${code}`, user.chat, id);
    expect(await repliesTo(user.chat.id)).toEqual([
      { kind: 'bot_reply', params: { reply: 'welcome' } },
    ]);
  });

  it('unlinks from the panel, audited; the chat is then ignored', async () => {
    const user = telegramUser();
    await linkAs(user);
    const link = await liveLink();
    const response = await client.delete('/api/admin/telegram/link', { cookie: admin.cookie });
    expect(await body(response)).toMatchObject({ status: 200, link: null });
    expect(await liveLink()).toBeUndefined();
    expect((await auditOf(test.db, link?.id ?? '')).map((entry) => entry.action)).toEqual([
      'telegram.linked',
      'telegram.unlinked',
    ]);
    await sendText(user, '/status');
    expect(await repliesTo(user.chat.id)).toHaveLength(1);
    // Unlinking again changes nothing.
    expect((await client.delete('/api/admin/telegram/link', { cookie: admin.cookie })).status).toBe(
      200,
    );
  });
});

describe('the test message', () => {
  it('needs a linked chat, then queues a message and shows it as the last one', async () => {
    await unlinkAll();
    expect(
      await body(await client.post('/api/admin/telegram/test', { cookie: admin.cookie })),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await linkAs(telegramUser());
    const since = new Date();
    const response = await client.post('/api/admin/telegram/test', { cookie: admin.cookie });
    expect(response.status).toBe(202);
    const rows = await test.db
      .select()
      .from(telegramMessages)
      .where(and(eq(telegramMessages.kind, 'test'), gt(telegramMessages.createdAt, since)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chatId: null, status: 'pending' });
    const status = await body(await client.get('/api/admin/telegram', { cookie: admin.cookie }));
    expect(status.lastMessage).toMatchObject({ status: 'pending', sentAt: null, error: null });
  });
});

describe('commands from the linked chat (rules TG4, TG7, AL4)', () => {
  let owner: User;

  beforeAll(async () => {
    owner = telegramUser();
    await linkAs(owner);
  });

  it('ignores anyone but the linked user in the linked chat', async () => {
    const stranger = telegramUser();
    await sendText(stranger, '/status');
    await sendText(stranger, '/stop');
    // The owner's user in another chat, and another user in the owner's chat.
    const group = { id: -1_000_000_000_000 - randomInt(1_000_000), type: 'group' };
    await sendText(owner, '/status', group);
    await sendText({ ...stranger, chat: owner.chat }, '/status');
    expect(await repliesTo(stranger.chat.id)).toEqual([]);
    expect(await repliesTo(group.id)).toEqual([]);
    expect(await lastReply(owner.chat.id)).toEqual({ reply: 'welcome' });
    expect((await tap(stranger, 'st:both')).status).toBe(200);
  });

  it('/status: the switches and what waits', async () => {
    await setSwitches(test.db, { registration_open: true });
    await sendText(owner, '/status@vertex_test_bot');
    expect(await lastReply(owner.chat.id)).toMatchObject({
      reply: 'status',
      switches: { registration_open: true, deposits_stopped: false },
      waiting: expect.any(Number),
      unmatchedTransfers: expect.any(Number),
    });
    await setSwitches(test.db);
  });

  it('/help, /start without a code and any other text: the help', async () => {
    for (const text of ['/help', '/start', 'hello']) {
      await sendText(owner, text);
      expect(await lastReply(owner.chat.id)).toEqual({ reply: 'help' });
    }
  });

  it('/stop, a scope, then confirm: the stop is on, from Telegram, with its notice (rules SW3, AL2)', async () => {
    await sendText(owner, '/stop');
    expect(await lastReply(owner.chat.id)).toEqual({ reply: 'stop_choose' });
    const choose = await tap(owner, 'st:deposits');
    expect(await choose.json()).toEqual({
      method: 'answerCallbackQuery',
      callback_query_id: expect.any(String),
    });
    const confirm = (await lastReply(owner.chat.id)) as { promptId: string };
    expect(confirm).toEqual({
      reply: 'stop_confirm',
      promptId: expect.any(String),
      scope: 'deposits',
    });

    const confirmed = await tap(owner, `ok:${confirm.promptId}`);
    expect(await confirmed.json()).toMatchObject({
      text: 'تم الإيقاف. إعادة الفتح من اللوحة فقط.',
    });
    const change = await switchValue('deposits_stopped');
    expect(change).toMatchObject({ value: true, channel: 'telegram', adminId: admin.id });
    expect(await auditOf(test.db, change?.id ?? '')).toEqual([
      expect.objectContaining({
        action: 'store_switch.changed',
        actorId: admin.id,
        channel: 'telegram',
        details: { switch: 'deposits_stopped', before: false, after: true },
      }),
    ]);
    const [notice] = await test.db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `switch:${change?.id}`));
    expect(notice).toMatchObject({
      kind: 'switch_changed',
      chatId: null,
      params: { switch: 'deposits_stopped', value: true, channel: 'telegram' },
    });
    // The prompt is closed: a second confirm does nothing.
    expect(await (await tap(owner, `ok:${confirm.promptId}`)).json()).toMatchObject({
      text: expect.stringContaining('انتهت صلاحية'),
    });
    expect((await switchValue('deposits_stopped'))?.id).toBe(change?.id);
  });

  it('a stop already on answers "متوقف مسبقاً"; "both" turns on only the other', async () => {
    expect(await (await tap(owner, 'st:deposits')).json()).toMatchObject({
      text: expect.stringContaining('متوقف مسبقاً'),
    });
    await tap(owner, 'st:both');
    const { promptId } = (await lastReply(owner.chat.id)) as { promptId: string };
    const depositsBefore = await switchValue('deposits_stopped');
    await tap(owner, `ok:${promptId}`);
    expect(await switchValue('purchases_stopped')).toMatchObject({
      value: true,
      channel: 'telegram',
    });
    expect((await switchValue('deposits_stopped'))?.id).toBe(depositsBefore?.id);
    await sendText(owner, '/stop');
    expect(await lastReply(owner.chat.id)).toEqual({ reply: 'stop_already' });
    await setSwitches(test.db);
  });

  it('never turns a stop off, and refuses buttons it never sent', async () => {
    await setSwitches(test.db, { deposits_stopped: true });
    const before = await switchValue('deposits_stopped');
    for (const data of ['st:off', 'st:', 'ok:not-a-prompt', 'xx:1']) {
      expect(await (await tap(owner, data)).json()).toEqual({
        method: 'answerCallbackQuery',
        callback_query_id: expect.any(String),
      });
    }
    expect((await switchValue('deposits_stopped'))?.id).toBe(before?.id);
    await setSwitches(test.db);
  });

  it('cancel closes the question; a new question closes the previous one (rule TG7)', async () => {
    await tap(owner, 'st:purchases');
    const first = ((await lastReply(owner.chat.id)) as { promptId: string }).promptId;
    await tap(owner, 'st:deposits');
    const second = ((await lastReply(owner.chat.id)) as { promptId: string }).promptId;
    const prompts = await test.db
      .select()
      .from(telegramPrompts)
      .where(inArray(telegramPrompts.id, [first, second]));
    expect(prompts.find((prompt) => prompt.id === first)?.closedAt).toBeInstanceOf(Date);
    expect(prompts.find((prompt) => prompt.id === second)?.closedAt).toBeNull();
    expect(await (await tap(owner, `ok:${first}`)).json()).toMatchObject({
      text: expect.stringContaining('انتهت صلاحية'),
    });
    expect(await (await tap(owner, `no:${second}`)).json()).toMatchObject({ text: 'أُلغي.' });
    expect((await switchValue('deposits_stopped'))?.value ?? false).toBe(false);
  });

  it('refuses a confirm after 10 minutes', async () => {
    await tap(owner, 'st:deposits');
    const { promptId } = (await lastReply(owner.chat.id)) as { promptId: string };
    await test.db
      .update(telegramPrompts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(telegramPrompts.id, promptId));
    expect(await (await tap(owner, `ok:${promptId}`)).json()).toMatchObject({
      text: expect.stringContaining('انتهت صلاحية'),
    });
    expect((await switchValue('deposits_stopped'))?.value ?? false).toBe(false);
  });

  it('an action that fails rolls back, is recorded and is told in the chat (rule TG5)', async () => {
    await tap(owner, 'st:deposits');
    const { promptId } = (await lastReply(owner.chat.id)) as { promptId: string };
    const settings = test.app.get(SettingsService);
    const spy = vi.spyOn(settings, 'changeIn').mockRejectedValueOnce(new Error('boom'));
    const id = updateId();
    try {
      expect(await (await tap(owner, `ok:${promptId}`, id)).json()).toMatchObject({
        text: 'تعذّر التنفيذ. حاول من اللوحة.',
      });
    } finally {
      spy.mockRestore();
    }
    // Rolled back: the prompt is still open; the update is recorded, so a redelivery is a no-op.
    const [prompt] = await test.db
      .select()
      .from(telegramPrompts)
      .where(eq(telegramPrompts.id, promptId));
    expect(prompt?.closedAt).toBeNull();
    expect((await tap(owner, `ok:${promptId}`, id)).status).toBe(200);
    expect((await switchValue('deposits_stopped'))?.value ?? false).toBe(false);

    vi.spyOn(settings, 'values').mockRejectedValueOnce(new Error('boom'));
    await sendText(owner, '/stop');
    expect(await lastReply(owner.chat.id)).toEqual({ reply: 'failed' });
  });
});

describe('switch notices from the panel (rule AL2)', () => {
  it('queues one switch_changed message per change, none for a no-op', async () => {
    await setSwitches(test.db);
    const change = (value: boolean) =>
      client.post('/api/admin/switches', {
        cookie: admin.cookie,
        body: { switch: 'sham_cash_paused', value },
      });
    expect((await change(true)).status).toBe(200);
    expect((await change(true)).status).toBe(200);
    const [row] = await test.db
      .select()
      .from(storeSwitchChanges)
      .where(eq(storeSwitchChanges.switch, 'sham_cash_paused'))
      .orderBy(desc(storeSwitchChanges.createdAt))
      .limit(1);
    const notices = await test.db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `switch:${row?.id}`));
    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'switch_changed',
        params: { switch: 'sham_cash_paused', value: true, channel: 'admin' },
      }),
    ]);
    const entries = await test.db
      .select()
      .from(auditEntries)
      .where(eq(auditEntries.entityId, row?.id ?? ''));
    expect(entries).toHaveLength(1);
    await change(false);
  });
});
