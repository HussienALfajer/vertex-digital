import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RATE_SETTINGS,
  type RateSettingsValues,
  TELEGRAM_MESSAGE_PARAMS,
} from '@vertex-digital/contracts';
import {
  createDatabase,
  exchangeRates,
  newestRate,
  newId,
  rateObservations,
  rateSettings,
  rateSources,
  rateSuggestions,
  type Transaction,
  telegramLinks,
  telegramMessages,
} from '@vertex-digital/db';
import { writeFakeTelegramPost } from '@vertex-digital/suppliers';
import { and, asc, eq, isNull, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { ExpireRateSuggestionsJob } from '../src/jobs/rates/expire-suggestions.job.js';
import { RatesPollJob } from '../src/jobs/rates/poll.job.js';
import { SendTelegramJob } from '../src/jobs/telegram/send.job.js';
import { TelegramBot } from '../src/telegram/bot-api.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * S27's worker side against the test database: `rates.poll` (SR1–SR5, AU1–AU7) reading pages this
 * file writes for the fake feed, `rates.expire-suggestions` (SG5), and the Telegram cards (SG1,
 * SG5, AU4). Rates, sources, settings and suggestions are global, so every run is inside a
 * transaction that is rolled back, with the other sources disabled and no pending suggestion.
 * Fixed instants in 2030 keep the decisions apart from the rows other tests leave.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const LINKS = { admin: 'http://127.0.0.1:5173' };
const NOW = new Date('2030-03-01T10:00:00Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
const pgBoss = { boss: { send: async () => null } } as unknown as PgBossService;
const jobs = { send: async () => undefined };

let dir = '';
let poller: RatesPollJob;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vertex-rate-feed-'));
  poller = new RatesPollJob(pgBoss, db, {
    RATE_FEED: 'fake',
    RATE_FEED_FAKE_DIR: dir,
    STORE_URL: 'http://127.0.0.1:3001',
  } as Env);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await connection.close();
});

/** Runs `work` in a rolled-back transaction with the rate at `rate` and no other live source. */
async function isolated(rate: string, work: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    db.transaction(async (tx) => {
      await tx.update(rateSources).set({ enabled: false }).where(isNull(rateSources.archivedAt));
      await tx
        .update(rateSuggestions)
        .set({ status: 'expired', decidedAt: new Date() })
        .where(eq(rateSuggestions.status, 'pending'));
      await tx
        .update(telegramLinks)
        .set({ unlinkedAt: new Date() })
        .where(isNull(telegramLinks.unlinkedAt));
      await tx.insert(exchangeRates).values({
        sypPerUsd: rate,
        displayStepSypUnits: 100,
        adminId: newId(),
      });
      await work(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

async function settings(tx: Transaction, values: Partial<RateSettingsValues>) {
  await tx.insert(rateSettings).values({ ...DEFAULT_RATE_SETTINGS, ...values, adminId: newId() });
}

/** A live channel source reading `دمشق`, posting `text` at `at` when given. */
async function channel(tx: Transaction, text?: string, at = NOW) {
  const handle = `rates_${newId().replaceAll('-', '').slice(-12)}`;
  const [row] = await tx
    .insert(rateSources)
    .values({
      kind: 'telegram_channel',
      label: `قناة ${handle.slice(-4)}`,
      handle,
      parser: { cityWord: 'دمشق', sellWord: 'مبيع', unit: 'new_syp' },
      enabled: true,
    })
    .returning();
  if (text !== undefined) await writeFakeTelegramPost(dir, handle, text, at);
  return row as typeof rateSources.$inferSelect;
}

const messages = (tx: Transaction, kind: keyof typeof TELEGRAM_MESSAGE_PARAMS) =>
  tx
    .select()
    .from(telegramMessages)
    .where(eq(telegramMessages.kind, kind))
    .orderBy(asc(telegramMessages.createdAt), asc(telegramMessages.id));

const pending = async (tx: Transaction) =>
  (await tx.select().from(rateSuggestions).where(eq(rateSuggestions.status, 'pending')))[0];

describe('rates.poll: applying alone (S27 AU4, AU7, acceptance 2)', () => {
  it('applies the highest of two agreeing fresh figures, audited, with a silent notice', () =>
    isolated('130', async (tx) => {
      await settings(tx, { autoEnabled: true });
      await channel(tx, 'دمشق: شراء 130 | مبيع 131');
      await channel(tx, 'دمشق مبيع 131.5');
      expect(await poller.poll(NOW, tx, jobs)).toBe('auto');
      const rate = await newestRate(tx);
      expect(rate).toMatchObject({ sypPerUsd: '131.5000', origin: 'auto', adminId: null });
      const [notice] = await messages(tx, 'rate_auto_changed');
      expect(notice?.params).toMatchObject({
        sypPerUsd: '131.5',
        changePercent: '1.16',
        sources: 2,
      });
      const rendered = renderTelegramMessage('rate_auto_changed', notice?.params as never, LINKS);
      expect(rendered.silent).toBe(true);
      expect(rendered.text).toContain('131.5 ل.س (+1.16%)');
      // SR1: a second run within the poll interval reads nothing (idempotent re-run).
      expect(await poller.poll(minutes(5), tx, jobs)).toBe('not_due');
      // The next due run finds the same figures: the move is now below the minimum.
      expect(await poller.poll(minutes(15), tx, jobs)).toBe('none');
      expect(
        await tx.select().from(rateObservations).where(like(rateObservations.excerpt, '%دمشق%')),
      ).toHaveLength(4);
    }));

  it('counts the 24-hour drift from a rate the owner set within the window', async () => {
    // Real time here: AU7 compares the rate in force with the run's real start.
    const now = new Date();
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const rollback = new Error('rollback');
    await expect(
      db.transaction(async (tx) => {
        await tx.update(rateSources).set({ enabled: false }).where(isNull(rateSources.archivedAt));
        await tx
          .update(rateSuggestions)
          .set({ status: 'expired', decidedAt: new Date() })
          .where(eq(rateSuggestions.status, 'pending'));
        // A day ago the rate was far away; the owner set 130 an hour ago.
        for (const [rate, hours] of [
          ['14100', 30],
          ['130', 1],
        ] as const) {
          await tx.insert(exchangeRates).values({
            sypPerUsd: rate,
            displayStepSypUnits: 100,
            adminId: newId(),
            createdAt: hoursAgo(hours),
          });
        }
        await settings(tx, { autoEnabled: true });
        await channel(tx, 'دمشق مبيع 131', now);
        await channel(tx, 'دمشق مبيع 131.5', now);
        expect(await poller.poll(now, tx, jobs)).toBe('auto');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('never creates the first rate, and reads nothing without a source', async () => {
    const rollback = new Error('rollback');
    await expect(
      db.transaction(async (tx) => {
        await tx.update(rateSources).set({ enabled: false }).where(isNull(rateSources.archivedAt));
        expect(await poller.poll(NOW, tx, jobs)).toBe('no_sources');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

describe('rates.poll: suggesting (S27 AU6, SG1, acceptance 3 and 4)', () => {
  it('sends a single-source move above 5% as a card without «اعتماد», once', () =>
    isolated('130', async (tx) => {
      await settings(tx, { autoEnabled: true });
      await channel(tx, 'دمشق مبيع 140');
      expect(await poller.poll(NOW, tx, jobs)).toBe('suggested');
      const suggestion = await pending(tx);
      expect(suggestion).toMatchObject({ proposedSypPerUsd: '140.0000', reason: 'single_source' });
      const [card] = await messages(tx, 'rate_suggestion');
      expect(card?.id).toBe(suggestion?.telegramMessageId);
      const rendered = renderTelegramMessage('rate_suggestion', card?.params as never, LINKS);
      expect(rendered.text).toContain('💱 اقتراح سعر صرف: 140 ل.س للدولار');
      expect(rendered.text).toContain('السبب: مصدر واحد فقط');
      expect(rendered.text).toContain('فوق حد تيليجرام');
      expect(rendered.buttons?.[0]?.map((button) => button.text)).toEqual(['رفض']);
      expect(rendered.buttons?.[1]?.map((button) => button.text)).toEqual([
        'إيقاف التحديث التلقائي',
      ]);
      // AU6: the same value next run keeps the card; no second suggestion.
      expect(await poller.poll(minutes(15), tx, jobs)).toBe('none');
      expect(await messages(tx, 'rate_suggestion')).toHaveLength(1);
    }));

  it('suggests the highest of disagreeing sources, then a two-source move above 2%', () =>
    isolated('130', async (tx) => {
      await settings(tx, { autoEnabled: true });
      const low = await channel(tx, 'دمشق مبيع 131');
      await channel(tx, 'دمشق مبيع 133');
      expect(await poller.poll(NOW, tx, jobs)).toBe('suggested');
      expect(await pending(tx)).toMatchObject({
        proposedSypPerUsd: '133.0000',
        reason: 'sources_disagree',
      });
      // The low source now agrees within 1%, but the move is above 2%: still a suggestion.
      await writeFakeTelegramPost(dir, low.handle, 'دمشق مبيع 134', minutes(15));
      expect(await poller.poll(minutes(15), tx, jobs)).toBe('suggested');
      const card = (await messages(tx, 'rate_suggestion')).at(-1);
      expect(card?.params).toMatchObject({
        proposedSypPerUsd: '134',
        reason: 'move_too_large',
        telegramApproves: true,
      });
      // The earlier card is edited to say it was superseded.
      const [closed] = await messages(tx, 'rate_suggestion_closed');
      expect(closed?.params).toMatchObject({ status: 'superseded' });
    }));

  it('suggests every move while automatic updates are off (edge case 7)', () =>
    isolated('130', async (tx) => {
      await settings(tx, { autoEnabled: false });
      await channel(tx, 'دمشق مبيع 131');
      await channel(tx, 'دمشق مبيع 131');
      expect(await poller.poll(NOW, tx, jobs)).toBe('suggested');
      expect(await pending(tx)).toMatchObject({ reason: 'auto_off' });
      expect((await newestRate(tx))?.origin).toBe('admin');
    }));
});

describe('rates.poll: reading and alerts (S27 SR1–SR4, AU1)', () => {
  it('stores out-of-range figures and alerts a broken source once', () =>
    isolated('130', async (tx) => {
      const source = await channel(tx, 'دمشق مبيع 13100');
      expect(await poller.poll(NOW, tx, jobs)).toBe('none');
      const [read] = await tx
        .select()
        .from(rateObservations)
        .where(eq(rateObservations.sourceId, source.id));
      expect(read).toMatchObject({ status: 'out_of_range', sypPerUsd: '13100.0000' });
      await poller.poll(minutes(15), tx, jobs);
      const alerts = await messages(tx, 'rate_source_broken');
      expect(alerts).toHaveLength(1);
      expect(
        renderTelegramMessage('rate_source_broken', alerts[0]?.params as never, LINKS).text,
      ).toContain('رقمه بعيد عن السعر الحالي');
    }));

  it('alerts after three failed reads, and alerts silence once', () =>
    isolated('130', async (tx) => {
      await settings(tx, { silentAlertHours: 1 });
      const missing = await channel(tx);
      for (const step of [0, 15, 30]) await poller.poll(minutes(step), tx, jobs);
      const reads = await tx
        .select()
        .from(rateObservations)
        .where(eq(rateObservations.sourceId, missing.id));
      expect(reads.map((read) => [read.status, read.errorCode])).toEqual([
        ['fetch_failed', 'http_404'],
        ['fetch_failed', 'http_404'],
        ['fetch_failed', 'http_404'],
      ]);
      expect(await messages(tx, 'rate_source_broken')).toHaveLength(1);
      // No figure ever: one silence alert for the whole episode.
      expect(await messages(tx, 'rate_sources_silent')).toHaveLength(1);
    }));

  it('treats a figure first seen long ago as stale, and a post time as fresh', () =>
    isolated('130', async (tx) => {
      await settings(tx, { autoEnabled: true });
      await channel(tx, 'دمشق مبيع 131', minutes(-181));
      await channel(tx, 'دمشق مبيع 131', minutes(-10));
      // One fresh figure only: a suggestion, never an automatic rate.
      expect(await poller.poll(NOW, tx, jobs)).toBe('suggested');
      expect(await pending(tx)).toMatchObject({ reason: 'single_source' });
    }));

  it('dates an unchanged figure from its first read, however many polls ago', () =>
    isolated('130', async (tx) => {
      await settings(tx, { autoEnabled: true, pollMinutes: 10, freshnessMinutes: 720 });
      const page = await tx
        .insert(rateSources)
        .values({
          kind: 'sp_today_page',
          label: 'صفحة',
          handle: '/currency/us-dollar',
          parser: { cityWord: null, sellWord: 'بيع', unit: 'new_syp' },
          enabled: true,
        })
        .returning();
      const sourceId = page[0]?.id as string;
      await mkdir(join(dir, 'sp_today_page'), { recursive: true });
      await writeFile(
        join(dir, 'sp_today_page', 'currency_us-dollar.html'),
        '<html><body><span>بيع</span><span>131</span></body></html>',
      );
      // 80 reads of the same figure, every 10 minutes: first seen more than 13 hours ago.
      await tx.insert(rateObservations).values(
        Array.from({ length: 80 }, (_, index) => ({
          sourceId,
          fetchedAt: minutes(-10 * (index + 1)),
          status: 'ok' as const,
          sypPerUsd: '131',
        })),
      );
      await channel(tx, 'دمشق مبيع 131');
      // Only the channel is fresh: one source suggests, the page never agrees with it.
      expect(await poller.poll(NOW, tx, jobs)).toBe('suggested');
      expect(await pending(tx)).toMatchObject({ reason: 'single_source' });
    }));

  it('alerts silence once while every figure stays old', () =>
    isolated('130', async (tx) => {
      await settings(tx, { silentAlertHours: 1 });
      await channel(tx, 'دمشق مبيع 131', minutes(-300));
      for (const step of [0, 15, 30, 45]) await poller.poll(minutes(step), tx, jobs);
      expect(await messages(tx, 'rate_sources_silent')).toHaveLength(1);
    }));

  it('reads only the fixed hosts', () =>
    isolated('130', async (tx) => {
      const urls: string[] = [];
      const reader = poller as unknown as { fetchFn: typeof fetch };
      const original = reader.fetchFn;
      reader.fetchFn = (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      try {
        await channel(tx);
        await tx.insert(rateSources).values({
          kind: 'sp_today_page',
          label: 'صفحة',
          handle: '/currency/us-dollar',
          parser: { cityWord: null, sellWord: 'بيع', unit: 'new_syp' },
          enabled: true,
        });
        // A row written past the panel's check never leaves for its host.
        await tx.insert(rateSources).values({
          kind: 'telegram_channel',
          label: 'مزيف',
          handle: 'evil.example/x',
          parser: { cityWord: null, sellWord: 'مبيع', unit: 'new_syp' },
          enabled: true,
        });
        await poller.poll(NOW, tx, jobs);
      } finally {
        reader.fetchFn = original;
      }
      expect(urls.map((url) => new URL(url).host).sort()).toEqual(['sp-today.com', 't.me']);
    }));
});

describe('rates.expire-suggestions and the card (S27 SG5)', () => {
  it('expires a suggestion pending for 6 hours and edits its card in place', () =>
    isolated('130', async (tx) => {
      await channel(tx, 'دمشق مبيع 140');
      await poller.poll(NOW, tx, jobs);
      const suggestion = await pending(tx);
      const expirer = new ExpireRateSuggestionsJob(pgBoss, db);
      expect(await expirer.expire(new Date(), tx)).toBe(false);
      expect(await expirer.expire(new Date(Date.now() + 6 * 3_600_000 + 60_000), tx)).toBe(true);
      expect(
        (
          await tx
            .select()
            .from(rateSuggestions)
            .where(eq(rateSuggestions.id, suggestion?.id as string))
        )[0],
      ).toMatchObject({ status: 'expired', adminId: null });
      const [closed] = await messages(tx, 'rate_suggestion_closed');
      expect(
        renderTelegramMessage('rate_suggestion_closed', closed?.params as never, LINKS).text,
      ).toBe('⌛ انتهى اقتراح السعر 140 ل.س دون قرار');

      // The send job edits the card the outbox sent, never a new message.
      await tx.insert(telegramLinks).values({
        id: newId(),
        adminId: newId(),
        chatId: 4242,
        telegramUserId: 4242,
      });
      await tx
        .update(telegramMessages)
        .set({ status: 'sent', telegramMessageId: 77 })
        .where(eq(telegramMessages.id, suggestion?.telegramMessageId as string));
      const calls: { method: string; payload: Record<string, unknown> }[] = [];
      const bot = new TelegramBot({ transport: 'log', apiUrl: 'http://127.0.0.1:9', logDir: dir });
      bot.call = async (method, payload) => {
        calls.push({ method, payload });
        return true;
      };
      const sender = new SendTelegramJob(pgBoss, bot, db, { ADMIN_URL: LINKS.admin } as Env);
      expect(await sender.send(closed?.id as string, new Date(), tx)).toBe('sent');
      expect(calls).toEqual([
        {
          method: 'editMessageText',
          payload: {
            chat_id: 4242,
            message_id: 77,
            text: '⌛ انتهى اقتراح السعر 140 ل.س دون قرار',
            reply_markup: { inline_keyboard: [] },
          },
        },
      ]);
      const [sent] = await tx
        .select()
        .from(telegramMessages)
        .where(and(eq(telegramMessages.id, closed?.id as string)));
      expect(sent?.status).toBe('sent');
    }));

  it('renders every outcome and the silence alert', () => {
    const closed = { suggestionId: newId(), cardMessageId: newId(), proposedSypPerUsd: '13200' };
    const text = (status: 'approved' | 'rejected' | 'superseded', applied: string | null = null) =>
      renderTelegramMessage(
        'rate_suggestion_closed',
        { ...closed, status, appliedSypPerUsd: applied },
        LINKS,
      ).text;
    expect(text('approved', '13150')).toBe('✅ اعتُمد السعر 13,150 ل.س (المقترح 13,200)');
    expect(text('approved')).toBe('✅ اعتُمد السعر 13,200 ل.س (المقترح 13,200)');
    expect(text('rejected')).toBe('❌ رُفض اقتراح السعر 13,200 ل.س');
    expect(text('superseded')).toBe('↩️ حلّ محلّ اقتراح السعر 13,200 ل.س تغيير أحدث');
    expect(renderTelegramMessage('rate_sources_silent', { hours: 6 }, LINKS).text).toContain(
      'لا سعر جديد من المصادر منذ 6 ساعات',
    );
    const broken = renderTelegramMessage(
      'rate_source_broken',
      { sourceId: newId(), label: 'قناة', status: 'no_match' },
      LINKS,
    ).text;
    expect(broken).toContain('لم يُقرأ منه سعر ثلاث مرات متتالية');
  });
});
