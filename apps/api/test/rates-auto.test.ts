import { randomInt } from 'node:crypto';
import { DEFAULT_RATE_SETTINGS } from '@vertex-digital/contracts';
import {
  adminSessions,
  createSuggestion,
  endSuggestion,
  exchangeRates,
  newestRate,
  pendingSuggestion,
  rateObservations,
  rateSettingsInForce,
  rateSources,
  rateSuggestions,
  telegramLinks,
  telegramMessages,
} from '@vertex-digital/db';
import { writeFakeTelegramPost } from '@vertex-digital/suppliers';
import { asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auditOf, body, PASSWORD, removeAccounts, seedCustomer, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * S27 automatic exchange-rate updates over HTTP against the test database: sources and their test
 * read (against pages this file writes for the fake feed, never the live sites), settings,
 * suggestions approved and rejected in the panel and from Telegram (SG2's cap re-checked at the
 * moment of approval). Rates, settings and suggestions are global and append-only: each test sets
 * the rate it needs and ends any pending suggestion first.
 */

const SECRET = 'test-webhook-secret-0123456789abcdef';
/** The fake feed's pages (`vitest.config.ts`), read by the API's test read. */
const FEED_DIR = process.env.RATE_FEED_FAKE_DIR as string;
const jobs = { send: async () => undefined };

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

const owner = (() => {
  const id = 8_000_000_000 + randomInt(1_000_000_000);
  return { chat: { id, type: 'private' }, from: { id, username: `owner${id}` } };
})();
let nextUpdateId = Date.now() * 1000 + 700_000;

const get = (path: string, cookie = admin.cookie) => client.get(path, { cookie });
const post = (path: string, input?: unknown, cookie = admin.cookie) =>
  client.post(path, { cookie, ...(input !== undefined && { body: input }) });

/** Sets the rate whatever the one in force, typing it twice in case the change is above 5%. */
async function setRate(sypPerUsd: string) {
  const response = await post('/api/admin/rates', {
    sypPerUsd,
    displayStepSypUnits: 100,
    rateConfirmation: sypPerUsd,
  });
  expect(response.status).toBe(201);
}

/** A pending suggestion of `value` against the rate in force, the earlier one superseded. */
async function suggest(value: string) {
  return test.db.transaction(async (tx) => {
    const base = await newestRate(tx);
    if (!base) throw new Error('No rate');
    return createSuggestion(tx, jobs, {
      sypPerUsd: value,
      base,
      reason: 'single_source',
      observationIds: [],
      settings: DEFAULT_RATE_SETTINGS,
      now: new Date(),
    });
  });
}

async function endPending() {
  await test.db.transaction(async (tx) => {
    const pending = await pendingSuggestion(tx);
    if (pending) await endSuggestion(tx, jobs, { suggestionId: pending.id, status: 'expired' });
  });
}

const suggestionRow = async (id: string) =>
  (await test.db.select().from(rateSuggestions).where(eq(rateSuggestions.id, id)))[0];

const currentRate = async () => (await newestRate(test.db))?.sypPerUsd;

const webhook = (payload: unknown) =>
  fetch(`${test.url}/api/webhooks/telegram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify(payload),
  });

/** Presses a button in the linked chat; the inline answer's text. */
async function tap(data: string): Promise<string | undefined> {
  nextUpdateId += 1;
  const response = await webhook({
    update_id: nextUpdateId,
    callback_query: {
      id: `q${nextUpdateId}`,
      from: owner.from,
      message: { message_id: 2, chat: owner.chat },
      data,
    },
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return text ? (JSON.parse(text) as { text?: string }).text : undefined;
}

const lastReply = async () =>
  (
    await test.db
      .select({ params: telegramMessages.params })
      .from(telegramMessages)
      .where(eq(telegramMessages.chatId, owner.chat.id))
      .orderBy(asc(telegramMessages.createdAt), asc(telegramMessages.id))
  ).at(-1)?.params as Record<string, unknown> | undefined;

const channelSource = (handle: string) => ({
  kind: 'telegram_channel',
  label: `قناة ${handle.slice(-6)}`,
  handle,
  parser: { cityWord: 'دمشق', unit: 'new_syp' },
});

const uniqueHandle = () => `rates_${randomInt(1_000_000_000)}`;

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await post('/api/admin/me/reauthenticate', {
    password: PASSWORD,
    totpCode: totp(admin.secret),
  });
  expect(reauthenticated.status).toBe(200);
  await setRate('130');
  await test.db
    .update(telegramLinks)
    .set({ unlinkedAt: new Date() })
    .where(isNull(telegramLinks.unlinkedAt));
  const code = await post('/api/admin/telegram/link-code');
  const { deepLink } = (await code.json()) as { deepLink: string };
  nextUpdateId += 1;
  await webhook({
    update_id: nextUpdateId,
    message: {
      message_id: 1,
      from: owner.from,
      chat: owner.chat,
      text: `/start ${new URL(deepLink).searchParams.get('start')}`,
    },
  });
  expect(await lastReply()).toEqual({ reply: 'welcome' });
});

afterAll(async () => {
  await endPending();
  await test.db
    .update(telegramLinks)
    .set({ unlinkedAt: new Date() })
    .where(isNull(telegramLinks.unlinkedAt));
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S27 "Access")', () => {
  const id = '00000000-0000-7000-8000-000000000000';
  const routes: [string, string, unknown?][] = [
    ['GET', '/api/admin/rate-sources'],
    ['POST', '/api/admin/rate-sources', channelSource('abcdefg')],
    ['POST', '/api/admin/rate-sources/test', channelSource('abcdefg')],
    ['PATCH', `/api/admin/rate-sources/${id}`, { enabled: false }],
    ['POST', `/api/admin/rate-sources/${id}/archive`],
    ['GET', '/api/admin/rate-suggestions'],
    ['POST', `/api/admin/rate-suggestions/${id}/approve`, {}],
    ['POST', `/api/admin/rate-suggestions/${id}/reject`],
    ['GET', '/api/admin/rate-settings'],
    ['POST', '/api/admin/rate-settings', DEFAULT_RATE_SETTINGS],
  ];

  it('answers 401 without a session and to a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    for (const options of [{}, { cookie }]) {
      for (const [method, path, input] of routes) {
        const response = await client.request(method, path, {
          ...options,
          ...(input !== undefined && { body: input }),
        });
        expect([method, path, response.status]).toEqual([method, path, 401]);
      }
    }
  });

  it('needs a re-authentication for source writes, approvals and settings', async () => {
    // This admin's re-authentication is cleared for the test, then restored: a second admin
    // would replace this one (ADR 0016).
    const setReauthenticated = (at: Date | null) =>
      test.db
        .update(adminSessions)
        .set({ reauthenticatedAt: at })
        .where(eq(adminSessions.userId, admin.id));
    await setReauthenticated(null);
    try {
      const sensitive = routes.filter(
        ([method, path]) =>
          method !== 'GET' && !path.endsWith('/test') && !path.endsWith('/reject'),
      );
      for (const [method, path, input] of sensitive) {
        const response = await client.request(method, path, {
          cookie: admin.cookie,
          ...(input !== undefined && { body: input }),
        });
        expect([path, await body(response)]).toMatchObject([
          path,
          { status: 403, code: 'REAUTHENTICATION_REQUIRED' },
        ]);
      }
      // The test read and the rejection are not re-authenticated (they answer past the check).
      const read = await post('/api/admin/rate-sources/test', channelSource('abcdefg'));
      expect(read.status).toBe(200);
      const reject = await post(`/api/admin/rate-suggestions/${id}/reject`);
      expect(await body(reject)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    } finally {
      await setReauthenticated(new Date());
    }
  });
});

describe('rate sources (S27 data, SR5)', () => {
  it('adds, lists with its reads, edits and archives a source, each audited', async () => {
    const handle = uniqueHandle();
    const created = await post('/api/admin/rate-sources', channelSource(handle));
    expect(created.status).toBe(201);
    const source = (await created.json()) as { id: string };
    expect(source).toMatchObject({
      handle,
      enabled: true,
      health: 'unknown',
      parser: { cityWord: 'دمشق', sellWord: 'مبيع', unit: 'new_syp' },
      observations: [],
    });
    await test.db.insert(rateObservations).values(
      ['no_match', 'ok', 'fetch_failed', 'no_match'].map((status, index) => ({
        sourceId: source.id,
        fetchedAt: new Date(Date.now() - index * 60_000),
        status: status as 'ok',
        sypPerUsd: status === 'ok' ? '131' : null,
      })),
    );
    const list = (await (await get('/api/admin/rate-sources')).json()) as {
      items: { id: string; health: string; observations: { status: string }[] }[];
    };
    const listed = list.items.find((item) => item.id === source.id);
    expect(listed?.observations.map((read) => read.status)).toEqual([
      'no_match',
      'ok',
      'fetch_failed',
    ]);
    expect(listed?.health).toBe('unknown');

    const wrongKind = await client.patch(`/api/admin/rate-sources/${source.id}`, {
      cookie: admin.cookie,
      body: { handle: '/currency/us-dollar' },
    });
    expect(await body(wrongKind)).toMatchObject({ status: 400, code: 'RATE_SOURCE_INVALID' });
    const edited = await client.patch(`/api/admin/rate-sources/${source.id}`, {
      cookie: admin.cookie,
      body: { label: 'قناة معدّلة', enabled: false },
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ label: 'قناة معدّلة', enabled: false });

    const archived = await post(`/api/admin/rate-sources/${source.id}/archive`);
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ enabled: false, archivedAt: expect.any(String) });
    const again = await post(`/api/admin/rate-sources/${source.id}/archive`);
    expect(await body(again)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((await auditOf(test.db, source.id)).map((entry) => entry.action)).toEqual([
      'rate_source.created',
      'rate_source.updated',
      'rate_source.archived',
    ]);
    const [updated] = (await auditOf(test.db, source.id)).filter(
      (entry) => entry.action === 'rate_source.updated',
    );
    expect(updated?.details).toEqual({
      sourceId: source.id,
      before: { label: expect.any(String), enabled: true },
      after: { label: 'قناة معدّلة', enabled: false },
    });
  });

  it('refuses a second live source on the same channel, and a handle of another kind', async () => {
    const handle = uniqueHandle();
    const created = await post(
      '/api/admin/rate-sources',
      channelSource(`@${handle.toUpperCase()}`),
    );
    expect(created.status).toBe(201);
    // Stored as the channel is: without `@`, in lower case.
    expect(((await created.json()) as { handle: string }).handle).toBe(handle);
    expect(await body(await post('/api/admin/rate-sources', channelSource(handle)))).toMatchObject({
      status: 400,
      code: 'RATE_SOURCE_INVALID',
    });
    for (const bad of ['evil.com', 'https://t.me/x', '/currency']) {
      expect(await body(await post('/api/admin/rate-sources', channelSource(bad)))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('test-reads a page without storing it, out of range beyond 20%', async () => {
    const handle = uniqueHandle();
    await setRate('130');
    await writeFakeTelegramPost(FEED_DIR, handle, 'دمشق: شراء 130 | مبيع ١٣١', new Date());
    const before = await test.db.select().from(rateObservations);
    const read = await post('/api/admin/rate-sources/test', channelSource(handle));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      status: 'ok',
      sypPerUsd: '131',
      excerpt: 'دمشق: شراء 130 | مبيع 131',
      postedAt: expect.any(String),
    });
    expect(await test.db.select().from(rateObservations)).toHaveLength(before.length);
    await writeFakeTelegramPost(FEED_DIR, handle, 'دمشق مبيع 13100', new Date());
    expect(
      await (await post('/api/admin/rate-sources/test', channelSource(handle))).json(),
    ).toMatchObject({
      status: 'out_of_range',
      sypPerUsd: '13100',
    });
    const missing = await post('/api/admin/rate-sources/test', channelSource(uniqueHandle()));
    expect(await missing.json()).toMatchObject({ status: 'fetch_failed', errorCode: 'http_404' });
  });

  it('allows 10 test reads a minute', async () => {
    const ip = `198.51.100.${randomInt(1, 250)}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await client.post('/api/admin/rate-sources/test', {
        cookie: admin.cookie,
        ip,
        body: channelSource('abcdefg'),
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('rate settings (S27 ST1, ST2)', () => {
  it('saves a new version only when something changed, audited, within bounds', async () => {
    const settings = (await (await get('/api/admin/rate-settings')).json()) as Record<
      string,
      unknown
    >;
    const { values } = await rateSettingsInForce(test.db);
    expect(settings).toMatchObject(values);
    const next = { ...values, autoEnabled: !values.autoEnabled, minMoveBps: 30 };
    const saved = await post('/api/admin/rate-settings', next);
    expect(saved.status).toBe(201);
    const after = (await saved.json()) as { id: string; adminName: string | null };
    expect(after).toMatchObject({ ...next, adminName: expect.any(String) });
    const [audit] = await auditOf(test.db, after.id);
    expect(audit).toMatchObject({ action: 'rate_settings.changed', channel: 'admin' });
    expect((audit?.details as { after?: unknown } | undefined)?.after).toEqual({
      autoEnabled: next.autoEnabled,
      ...(values.minMoveBps !== 30 && { minMoveBps: 30 }),
    });
    const same = await post('/api/admin/rate-settings', next);
    expect(((await same.json()) as { id: string }).id).toBe(after.id);
    for (const bad of [
      { telegramApproveMaxBps: 600 },
      { minAgreeingSources: 1 },
      { pollMinutes: 5 },
    ]) {
      expect(await body(await post('/api/admin/rate-settings', { ...next, ...bad }))).toMatchObject(
        {
          status: 400,
          code: 'VALIDATION_FAILED',
        },
      );
    }
    await post('/api/admin/rate-settings', DEFAULT_RATE_SETTINGS);
  });
});

describe('suggestions in the panel (S27 SG2–SG4, edge case 4)', () => {
  it('shows the pending suggestion on /rates and in the list', async () => {
    await setRate('130');
    const suggestion = await suggest('134');
    const overview = (await (await get('/api/admin/rates')).json()) as Record<string, unknown>;
    expect(overview).toMatchObject({
      autoEnabled: expect.any(Boolean),
      pendingSuggestion: {
        id: suggestion.id,
        proposedSypPerUsd: '134',
        baseSypPerUsd: '130',
        changePercent: '3.08',
        status: 'pending',
      },
      current: { origin: 'admin' },
    });
    const pending = (await (await get('/api/admin/rate-suggestions?status=pending')).json()) as {
      items: { id: string }[];
    };
    expect(pending.items.map((item) => item.id)).toEqual([suggestion.id]);
  });

  it('approves an edited value with its typed confirmation above 5%, once', async () => {
    await setRate('130');
    const suggestion = await suggest('140');
    const unconfirmed = await post(`/api/admin/rate-suggestions/${suggestion.id}/approve`, {});
    expect(await body(unconfirmed)).toMatchObject({
      status: 400,
      code: 'RATE_CONFIRMATION_REQUIRED',
    });
    const edited = await post(`/api/admin/rate-suggestions/${suggestion.id}/approve`, {
      sypPerUsd: '139.5',
      rateConfirmation: '139.5',
    });
    expect(edited.status).toBe(201);
    expect(await edited.json()).toMatchObject({
      origin: 'suggestion',
      sypPerUsd: '139.5',
      adminName: expect.any(String),
    });
    expect(await suggestionRow(suggestion.id)).toMatchObject({
      status: 'approved',
      decidedChannel: 'panel',
      adminId: admin.id,
    });
    const [rate] = await test.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.suggestionId, suggestion.id));
    expect(rate).toMatchObject({ origin: 'suggestion', sypPerUsd: '139.5000' });
    expect((await auditOf(test.db, suggestion.id)).at(-1)).toMatchObject({
      action: 'rate_suggestion.approved',
      details: { approvedSypPerUsd: '139.5', proposedSypPerUsd: '140', channel: 'panel' },
    });
    const twice = await post(`/api/admin/rate-suggestions/${suggestion.id}/approve`, {});
    expect(await body(twice)).toMatchObject({
      status: 409,
      code: 'RATE_SUGGESTION_STATE_CONFLICT',
    });
  });

  it('rejects without a reason, and a manual change supersedes the pending one', async () => {
    await setRate('130');
    const rejected = await suggest('133');
    const response = await post(`/api/admin/rate-suggestions/${rejected.id}/reject`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'rejected', decidedChannel: 'panel' });
    const superseded = await suggest('133.5');
    await setRate('131');
    expect(await suggestionRow(superseded.id)).toMatchObject({
      status: 'superseded',
      adminId: null,
    });
    const late = await post(`/api/admin/rate-suggestions/${superseded.id}/reject`);
    expect(await body(late)).toMatchObject({ status: 409, code: 'RATE_SUGGESTION_STATE_CONFLICT' });
  });
});

describe('suggestions from Telegram (S27 SG1, SG2, ST1)', () => {
  it('approves within the cap, checked against the rate at that moment', async () => {
    await setRate('130');
    const near = await suggest('134');
    expect(await tap(`ra:${near.id}`)).toBe('اعتُمد السعر الجديد.');
    expect(await currentRate()).toBe('134.0000');
    expect(await suggestionRow(near.id)).toMatchObject({
      status: 'approved',
      decidedChannel: 'telegram',
    });
    expect((await auditOf(test.db, near.id)).at(-1)).toMatchObject({
      action: 'rate_suggestion.approved',
      channel: 'telegram',
    });
    expect(await tap(`ra:${near.id}`)).toBe('تم البت فيه مسبقاً.');

    // The rate moved since a suggestion was made: 136 is within 5% of 130, not of 129.
    await setRate('129');
    const again = await suggest('136');
    expect(await tap(`ra:${again.id}`)).toBe('التغيير الآن فوق حد تيليجرام: اعتمد من اللوحة.');
    expect(await suggestionRow(again.id)).toMatchObject({ status: 'pending' });
    expect(await currentRate()).toBe('129.0000');
    expect(await tap(`rx:${again.id}`)).toBe('رُفض الاقتراح.');
    expect(await suggestionRow(again.id)).toMatchObject({
      status: 'rejected',
      decidedChannel: 'telegram',
    });
  });

  it('edits the card to its outcome', async () => {
    await setRate('130');
    const suggestion = await suggest('132');
    expect(suggestion.telegramMessageId).not.toBeNull();
    await tap(`rx:${suggestion.id}`);
    const [closed] = await test.db
      .select({ params: telegramMessages.params })
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `rate-suggestion:${suggestion.id}:closed`));
    expect(closed?.params).toMatchObject({
      status: 'rejected',
      cardMessageId: suggestion.telegramMessageId,
    });
  });

  it('turns automatic updates off after the confirm button, never on', async () => {
    const { values } = await rateSettingsInForce(test.db);
    await post('/api/admin/rate-settings', { ...values, autoEnabled: true });
    expect(await tap('ro:auto')).toBeUndefined();
    const reply = await lastReply();
    expect(reply).toMatchObject({ reply: 'rate_auto_off_confirm', promptId: expect.any(String) });
    expect((await rateSettingsInForce(test.db)).values.autoEnabled).toBe(true);
    expect(await tap(`ok:${reply?.promptId}`)).toBe('أُوقف التحديث التلقائي. تشغيله من اللوحة فقط.');
    const { row, values: after } = await rateSettingsInForce(test.db);
    expect(after.autoEnabled).toBe(false);
    expect((await auditOf(test.db, row?.id ?? '')).at(-1)).toMatchObject({
      action: 'rate_settings.changed',
      channel: 'telegram',
    });
    await tap('ro:auto');
    const second = await lastReply();
    expect(await tap(`ok:${second?.promptId}`)).toBe('التحديث التلقائي متوقف مسبقاً.');
  });
});

describe('sources leave nothing behind', () => {
  it('keeps archived sources out of the list', async () => {
    const list = (await (await get('/api/admin/rate-sources')).json()) as {
      items: { archivedAt: string | null }[];
    };
    expect(list.items.every((item) => item.archivedAt === null)).toBe(true);
    const live = await test.db.select().from(rateSources).where(isNull(rateSources.archivedAt));
    expect(live.length).toBe(list.items.length);
  });
});
