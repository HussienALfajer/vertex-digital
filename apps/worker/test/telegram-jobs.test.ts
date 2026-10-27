import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEPOSIT_SETTINGS_DEFAULTS,
  TELEGRAM_MESSAGE_PARAMS,
  type TelegramMessageParams,
} from '@vertex-digital/contracts';
import {
  createDatabase,
  customers,
  depositReceipts,
  depositSettings,
  deposits,
  newId,
  storedFiles,
  type Transaction,
  telegramBotState,
  telegramDepositCards,
  telegramLinks,
  telegramMessages,
  telegramPrompts,
  telegramUpdates,
} from '@vertex-digital/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { TelegramAlerts } from '../src/core/alerts/telegram-alerts.js';
import type { Env } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { DailySummaryJob, damascusDate } from '../src/jobs/telegram/daily-summary.job.js';
import { DepositCardJob } from '../src/jobs/telegram/deposit-card.job.js';
import { ReviewReminderJob } from '../src/jobs/telegram/review-reminder.job.js';
import { TelegramApiError, TelegramBot } from '../src/telegram/bot-api.js';
import { renderDepositCard, renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * The deposit cards, the review reminder and the daily summary (S05 rules TC1–TC7, RM1–RM4, AL3)
 * against the test database. The live link, the bot state and the settings are shared by the
 * whole database, so every job runs inside a transaction that is rolled back. Fixed instants in
 * 2030 keep the reminder and the summary apart from the rows other tests leave.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const USD = 1_000_000;
const LINKS = { admin: 'http://127.0.0.1:5173' };
const FILES_ROOT = process.env.FILES_ROOT as string;
const env = { ADMIN_URL: LINKS.admin, FILES_ROOT } as Env;
const pgBoss = { boss: { send: async () => null } } as unknown as PgBossService;

afterAll(() => connection.close());

/** Runs `work` in a transaction that is always rolled back, with no live link. */
async function isolated(work: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    db.transaction(async (tx) => {
      await tx
        .update(telegramLinks)
        .set({ unlinkedAt: new Date() })
        .where(isNull(telegramLinks.unlinkedAt));
      await work(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

const link = (tx: Transaction, chatId = 4242) =>
  tx
    .insert(telegramLinks)
    .values({ id: newId(), adminId: newId(), chatId, telegramUserId: chatId });

const code = () =>
  `VD-${Array.from({ length: 5 }, () => '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 31)]).join('')}`;

/** A USD Sham Cash deposit with a receipt on disk, moved to `submitted` at `submittedAt`. */
async function submitted(tx: Transaction, dollars: number, submittedAt = new Date()) {
  const customerId = newId();
  await tx.insert(customers).values({
    id: customerId,
    name: 'سامر',
    email: `${customerId}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  const id = newId();
  await tx.insert(deposits).values({
    id,
    customerId,
    method: 'sham_cash',
    referenceCode: code(),
    currency: 'USD',
    declaredAmountUnits: dollars * USD,
    declaredUsdUnits: dollars * USD,
    expiresAt: new Date(Date.now() + 3_600_000),
    idempotencyKey: newId(),
  });
  await receipt(tx, id);
  await tx.update(deposits).set({ status: 'submitted', submittedAt }).where(eq(deposits.id, id));
  return id;
}

async function receipt(tx: Transaction, depositId: string) {
  const fileId = newId();
  const storageKey = `deposit_receipt/ab/${randomUUID()}.webp`;
  const image = await sharp(randomBytes(16 * 16 * 3), {
    raw: { width: 16, height: 16, channels: 3 },
  })
    .webp()
    .toBuffer();
  await mkdir(dirname(join(FILES_ROOT, storageKey)), { recursive: true });
  await writeFile(join(FILES_ROOT, storageKey), image);
  await tx.insert(storedFiles).values({
    id: fileId,
    kind: 'deposit_receipt',
    storageKey,
    contentType: 'image/webp',
    byteSize: image.length,
    width: 16,
    height: 16,
  });
  await tx.insert(depositReceipts).values({
    id: newId(),
    depositId,
    fileId,
    originalSha256: randomBytes(32),
    perceptualHash: 1n,
  });
}

const readFiles = async (dir: string) => {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))),
  ) as Promise<Record<string, unknown>[]>;
};

describe('the deposit card (rules TC1, TC2, TC6)', () => {
  it('sends the receipt as a photo once, then edits it to the outcome', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vertex-digital-cards-'));
    const job = new DepositCardJob(
      pgBoss,
      new TelegramBot({ transport: 'log', apiUrl: 'http://127.0.0.1:9', logDir: dir }),
      db,
      env,
    );
    await isolated(async (tx) => {
      // The settings in force, whatever other test files saved: the $100 default limit.
      await tx.insert(depositSettings).values({
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex',
        shamCashAccountNumber: '0933000000',
        adminId: newId(),
      });
      const id = await submitted(tx, 20);
      // No live link: nothing is sent, and nothing is replayed later (edge case 2).
      expect(await job.sync(id, tx)).toBe('skipped');
      await link(tx);
      expect(await job.sync(id, tx)).toBe('sent');
      expect(await job.sync(id, tx)).toBe('none');
      const [photo] = await readFiles(dir);
      expect(photo).toMatchObject({
        method: 'sendPhoto',
        chat_id: 4242,
        photo: expect.stringMatching(/\.jpg$/),
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'اعتماد $20.00', callback_data: `ap:${id}` },
              { text: 'رفض', callback_data: `rj:${id}` },
            ],
          ],
        },
      });
      expect(photo?.caption).toContain('حساب جديد');
      const jpeg = await readFile(join(dir, photo?.photo as string));
      expect((await sharp(jpeg).metadata()).format).toBe('jpeg');
      await tx
        .update(deposits)
        .set({
          status: 'rejected',
          decidedAt: new Date(),
          decidedBy: 'admin',
          adminId: newId(),
          rejectReason: 'not_received',
          decisionIdempotencyKey: newId(),
        })
        .where(eq(deposits.id, id));
      expect(await job.sync(id, tx)).toBe('edited');
      const edit = (await readFiles(dir)).at(-1);
      expect(edit).toMatchObject({
        method: 'editMessageCaption',
        chat_id: 4242,
        reply_markup: { inline_keyboard: [] },
      });
      expect(edit?.caption).toMatch(/^❌ رُفض: لم يصل التحويل/);
      // Safe twice.
      expect(await job.sync(id, tx)).toBe('edited');
    });
  });

  it('edits a card sent as text to its outcome (F4-14)', async () => {
    // A Bot API that keeps each message's kind and refuses a caption edit on text, as Telegram does.
    const kinds = new Map<number, 'photo' | 'text'>();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let next = 100;
    const bot = {
      configured: true,
      async call(method: string, params: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === 'sendMessage') {
          next += 1;
          kinds.set(next, 'text');
          return { message_id: next };
        }
        if (method === 'editMessageCaption' && kinds.get(params.message_id as number) === 'text') {
          throw new TelegramApiError(
            400,
            'Bad Request: there is no caption in the message to edit',
          );
        }
        return true;
      },
      async callWithFile() {
        throw new Error('A card with an unreadable receipt is sent as text');
      },
    } as unknown as TelegramBot;
    const job = new DepositCardJob(pgBoss, bot, db, env);
    await isolated(async (tx) => {
      await link(tx);
      const id = await submitted(tx, 20);
      // The receipt's file is gone: the card goes out as text.
      const [stored] = await tx
        .select({ key: storedFiles.storageKey })
        .from(depositReceipts)
        .innerJoin(storedFiles, eq(storedFiles.id, depositReceipts.fileId))
        .where(eq(depositReceipts.depositId, id));
      await rm(join(FILES_ROOT, stored?.key ?? 'missing'), { force: true });
      expect(await job.sync(id, tx)).toBe('sent');
      expect(calls.at(-1)?.method).toBe('sendMessage');
      await tx
        .update(deposits)
        .set({
          status: 'rejected',
          decidedAt: new Date(),
          decidedBy: 'admin',
          adminId: newId(),
          rejectReason: 'not_received',
          decisionIdempotencyKey: newId(),
        })
        .where(eq(deposits.id, id));
      expect(await job.sync(id, tx)).toBe('edited');
      expect(calls.at(-1)).toMatchObject({
        method: 'editMessageText',
        params: { reply_markup: { inline_keyboard: [] } },
      });
    });
  });

  it('sends a card decided before it was sent, with its outcome and no buttons (F4-15)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vertex-digital-cards-'));
    const job = new DepositCardJob(
      pgBoss,
      new TelegramBot({ transport: 'log', apiUrl: 'http://127.0.0.1:9', logDir: dir }),
      db,
      env,
    );
    await isolated(async (tx) => {
      await tx.insert(telegramLinks).values({
        id: newId(),
        adminId: newId(),
        chatId: 4242,
        telegramUserId: 4242,
        linkedAt: new Date(Date.now() - 3_600_000),
      });
      const decide = (id: string) =>
        tx
          .update(deposits)
          .set({
            status: 'rejected',
            decidedAt: new Date(),
            decidedBy: 'admin',
            adminId: newId(),
            rejectReason: 'not_received',
            decisionIdempotencyKey: newId(),
          })
          .where(eq(deposits.id, id));
      // The worker was behind: the deposit was decided before its first card job ran.
      const id = await submitted(tx, 20);
      await decide(id);
      expect(await job.sync(id, tx)).toBe('sent');
      const [card] = await readFiles(dir);
      expect(card).toMatchObject({ method: 'sendPhoto', reply_markup: { inline_keyboard: [] } });
      expect(card?.caption).toMatch(/^❌ رُفض/);
      expect(await job.sync(id, tx)).toBe('edited');
      // A submission made before the chat was linked gets no card, then or later (edge case 2).
      const before = await submitted(tx, 20, new Date(Date.now() - 7_200_000));
      await decide(before);
      expect(await job.sync(before, tx)).toBe('none');
    });
  });

  it('says why a deposit has no approve button', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vertex-digital-cards-'));
    const job = new DepositCardJob(
      pgBoss,
      new TelegramBot({ transport: 'log', apiUrl: 'http://127.0.0.1:9', logDir: dir }),
      db,
      env,
    );
    await isolated(async (tx) => {
      await link(tx);
      await tx.insert(depositSettings).values({
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex',
        shamCashAccountNumber: '0933000000',
        adminId: newId(),
        telegramApprovalMaxUsdUnits: 50 * USD,
      });
      const id = await submitted(tx, 60);
      await job.sync(id, tx);
      const [card] = await readFiles(dir);
      expect(card?.caption).toContain('فوق حد تيليجرام');
      expect(card?.reply_markup).toEqual({
        inline_keyboard: [[{ text: 'رفض', callback_data: `rj:${id}` }]],
      });
    });
  });

  it('gives each submission its own card after a clearer-receipt request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vertex-digital-cards-'));
    const job = new DepositCardJob(
      pgBoss,
      new TelegramBot({ transport: 'log', apiUrl: 'http://127.0.0.1:9', logDir: dir }),
      db,
      env,
    );
    await isolated(async (tx) => {
      await link(tx);
      const id = await submitted(tx, 10, new Date(Date.now() - 60_000));
      expect(await job.sync(id, tx)).toBe('sent');
      await tx
        .update(deposits)
        .set({
          status: 'pending',
          receiptRequestedAt: new Date(),
          receiptRequestCount: 1,
        })
        .where(eq(deposits.id, id));
      expect(await job.sync(id, tx)).toBe('edited');
      expect((await readFiles(dir)).at(-1)?.caption).toMatch(/^↩️ طُلب إيصال أوضح/);
      await receipt(tx, id);
      await tx
        .update(deposits)
        .set({ status: 'submitted', submittedAt: new Date() })
        .where(eq(deposits.id, id));
      expect(await job.sync(id, tx)).toBe('sent');
      const cards = await tx
        .select()
        .from(telegramDepositCards)
        .where(eq(telegramDepositCards.depositId, id));
      expect(cards).toHaveLength(2);
    });
  });

  it('waits out a 429 by queueing the card after `retry_after` (A07-26)', async () => {
    const sent: { data: unknown; options: Record<string, unknown> }[] = [];
    const boss = {
      boss: {
        send: async (_queue: string, data: unknown, options: Record<string, unknown>) => {
          sent.push({ data, options });
          return null;
        },
      },
    } as unknown as PgBossService;
    const bot = new TelegramBot({
      transport: 'log',
      apiUrl: 'http://127.0.0.1:9',
      logDir: tmpdir(),
    });
    const tooMany = new TelegramApiError(429, 'Too Many Requests: retry after 37', 37);
    bot.call = async () => {
      throw tooMany;
    };
    bot.callWithFile = bot.call;
    const job = new DepositCardJob(boss, bot, db, env);
    await isolated(async (tx) => {
      await tx.insert(depositSettings).values({
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex',
        shamCashAccountNumber: '0933000000',
        adminId: newId(),
      });
      const id = await submitted(tx, 20);
      await link(tx);
      expect(await job.sync(id, tx)).toBe('deferred');
      expect(sent).toEqual([
        {
          data: { depositId: id },
          options: expect.objectContaining({ singletonKey: id, startAfter: 37 }),
        },
      ]);
    });
  });
});

describe('the review reminder (rules RM1–RM4)', () => {
  // 2030-01-01 in Damascus (UTC+3): 07:00Z is 10:00, the opening.
  const at = (time: string) => new Date(`2030-01-01T${time}:00Z`);

  it('reminds at the target within hours, then every 30 minutes', async () => {
    const job = new ReviewReminderJob(pgBoss, db);
    await isolated(async (tx) => {
      await tx.insert(depositSettings).values({
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex',
        shamCashAccountNumber: '0933000000',
        adminId: newId(),
      });
      await tx.insert(telegramBotState).values({ id: 1 }).onConflictDoNothing();
      // Not null: deposits other test files leave waiting are overdue and were "listed" before.
      await tx.update(telegramBotState).set({ lastReminderAt: at('07:00') });
      // 23:00 the evening before, in Damascus.
      const id = await submitted(tx, 5, new Date('2029-12-31T20:00:00Z'));
      await tx.insert(telegramDepositCards).values({
        depositId: id,
        submittedAt: new Date('2029-12-31T20:00:00Z'),
        chatId: 1,
        messageId: 1,
      });
      const old = Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 1e9);
      await tx
        .insert(telegramUpdates)
        .values({ updateId: old, receivedAt: new Date('2029-12-20T00:00:00Z') });
      await tx
        .update(telegramPrompts)
        .set({ closedAt: new Date() })
        .where(isNull(telegramPrompts.closedAt));
      const [prompt] = await tx
        .insert(telegramPrompts)
        .values({
          id: newId(),
          kind: 'stop_confirm',
          data: { scope: 'both' },
          expiresAt: at('06:00'),
        })
        .returning();

      expect(await job.remind(at('06:59'), tx)).toBe(false);
      // Outside hours it still prunes old update ids and closes expired prompts.
      expect(
        await tx.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, old)),
      ).toEqual([]);
      const [closed] = await tx
        .select({ closedAt: telegramPrompts.closedAt })
        .from(telegramPrompts)
        .where(eq(telegramPrompts.id, prompt?.id as string));
      expect(closed?.closedAt).not.toBeNull();

      expect(await job.remind(at('07:10'), tx)).toBe(false);
      expect(await job.remind(at('07:15'), tx)).toBe(true);
      const [message] = await tx
        .select()
        .from(telegramMessages)
        .where(eq(telegramMessages.kind, 'review_reminder'))
        // The one this transaction wrote: a reminder another run committed is older.
        .orderBy(desc(telegramMessages.createdAt))
        .limit(1);
      const params = TELEGRAM_MESSAGE_PARAMS.review_reminder.parse(message?.params);
      expect(params.count).toBeGreaterThanOrEqual(1);
      const [card] = await tx
        .select({ remindedAt: telegramDepositCards.remindedAt })
        .from(telegramDepositCards)
        .where(and(eq(telegramDepositCards.depositId, id)));
      // Listed when among the 10 oldest; earlier rows of other tests may be older.
      if (params.count <= 10) expect(card?.remindedAt).toEqual(at('07:15'));
      expect(await job.remind(at('07:20'), tx)).toBe(false);
      expect(await job.remind(at('07:45'), tx)).toBe(true);
    });
  });
});

describe('the daily summary (rule AL3)', () => {
  it('counts the Damascus day and is sent once', async () => {
    const alerts = new TelegramAlerts(
      { source: 'test' },
      { configured: false, call: async () => null },
      async () => null,
    );
    const job = new DailySummaryJob(pgBoss, alerts, db, { ...env, SUPPLIER_FAKE_ENABLED: true });
    const now = new Date('2030-01-01T19:30:00Z');
    expect(damascusDate(now)).toBe('2030-01-01');
    await isolated(async (tx) => {
      const id = await submitted(tx, 7, new Date('2030-01-01T08:00:00Z'));
      await tx
        .update(deposits)
        .set({
          status: 'rejected',
          decidedAt: new Date('2030-01-01T09:00:00Z'),
          decidedBy: 'admin',
          adminId: newId(),
          rejectReason: 'not_received',
          decisionIdempotencyKey: newId(),
        })
        .where(eq(deposits.id, id));
      expect(await job.summarize(now, tx)).toBe(true);
      expect(await job.summarize(now, tx)).toBe(false);
      const [message] = await tx
        .select()
        .from(telegramMessages)
        .where(eq(telegramMessages.dedupeKey, 'summary:2030-01-01'));
      const summary = TELEGRAM_MESSAGE_PARAMS.daily_summary.parse(message?.params);
      expect(summary).toMatchObject({ date: '2030-01-01', suppressedAlerts: 0 });
      expect(summary.rejected).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('the messages of PR 4', () => {
  it('render the unmatched transfer, the reminder and the summary', () => {
    expect(
      renderTelegramMessage(
        'usdt_unmatched',
        {
          transferId: newId(),
          method: 'usdt_trc20',
          amountUnits: 25_003_700,
          sender: 'TXyz12…abcdef',
          candidates: 2,
        },
        LINKS,
      ).text.split('\n'),
    ).toEqual([
      '⚠️ تحويل USDT غير مطابق على USDT TRC20',
      'المبلغ: 25.0037 USDT',
      'المرسل: TXyz12…abcdef',
      'طلبات مرشّحة: 2',
      'http://127.0.0.1:5173/deposits/transfers',
    ]);
    const reminder = renderTelegramMessage(
      'review_reminder',
      {
        count: 12,
        oldestWaitMinutes: 135,
        deposits: Array.from({ length: 10 }, (_, index) => ({
          referenceCode: `VD-AAAA${index}`,
          waitMinutes: 135 - index,
        })),
      },
      LINKS,
    ).text;
    expect(reminder).toContain('12 إيداع بانتظار المراجعة، أقدمها منذ 2 س 15 د');
    expect(reminder).toContain('و 2 غيرها');
    const summary: TelegramMessageParams<'daily_summary'> = {
      date: '2030-01-01',
      credited: [{ method: 'sham_cash', count: 3, usdUnits: 75 * USD }],
      approvedFromTelegram: 2,
      rejected: 1,
      expired: 0,
      waiting: 1,
      oldestWaitMinutes: 20,
      unmatchedToday: 0,
      unmatchedOpen: 1,
      newCustomers: 4,
      walletsTotalUsdUnits: 1234 * USD,
      registrationOpen: false,
      activeSwitches: [{ switch: 'deposits_stopped', since: '2030-01-01T10:00:00Z' }],
      suppressedAlerts: 3,
      openReviews: 2,
      marginGuarded: 1,
      suppliersNotHealthy: [{ supplierNameAr: 'WDGZone', state: 'degraded' }],
      balancesLow: [{ supplierNameAr: 'WDGZone', currency: 'USD', amountUnits: 20 * USD }],
      syncsFailing: [],
      plansInactive: [],
      ordersDelivered: 7,
      ordersPartiallyRefunded: 1,
      ordersRefunded: 2,
      ordersInReview: 1,
      manualWaiting: 3,
      medianDeliveryMs: 45_000,
      validations: [
        { supplierNameAr: 'مورد تجريبي', count: 12 },
        { supplierNameAr: 'WDGZone', count: 3 },
      ],
      reservationsPaid: 4,
      reservationsExpired: 1,
      checkouts: 2,
      checkoutOrders: 5,
      ticketsOpened: 3,
      ticketsWaiting: 2,
      reconciliation: { date: '2029-12-31', status: 'finished', mismatches: 2, open: 3 },
      ownerOrders: { count: 2, usedUsdUnits: 12_500_000, capUsdUnits: 100_000_000 },
      newPacks: [{ supplierNameAr: 'WDGZone', count: 7 }],
      stockLow: { low: 2, out: 1 },
      fixedPriceFallbacks: 2,
      merchantApplicationsWaiting: 3,
      merchantLevelsChanged: 2,
    };
    const text = renderTelegramMessage('daily_summary', summary, LINKS).text;
    for (const line of [
      '• شام كاش: 3 بقيمة $75.00',
      'منها من تيليجرام: 2',
      'التسجيل: مغلق',
      '⛔ الإيداع متوقف منذ 01/01 13:00',
      'تنبيهات حُجبت بحد الإرسال: 3',
      'مراجعات أسعار مفتوحة: 2',
      'الطلبات اليوم: 7 مُسلّمة، 1 جزئية، 2 مستردة',
      'بحاجة لمراجعة: 1 · يدوي بانتظارك: 3',
      'وسيط وقت التسليم اليوم: 45 ث',
      'باقات أوقفها حارس الهامش: 1',
      '⚠️ المورد WDGZone: متراجع',
      '💰 رصيد WDGZone تحت الحد: $20.00',
      'الحجوزات اليوم: 4 دُفعت، 1 انتهت',
      'سلال اليوم: 2 (5 طلبات)',
      'تذاكر جديدة اليوم: 3 · بانتظار ردّك الآن: 2',
      'التحقق من المعرّف اليوم: مورد تجريبي 12، WDGZone 3',
      '📦 باقات جديدة في فئات مستوردة: 7 (WDGZone)',
      '📉 مخزون الباقات المربوطة: 2 منخفض، 1 نافد',
      '🏷️ أسعار ثابتة تحت الهامش تُباع بسعر القاعدة: 2',
      '🏪 طلبات تاجر بانتظار المراجعة: 3',
      '🏅 مستويات التجار: 2 تغيّرت اليوم',
      'المطابقة الليلية 2029-12-31: 2 فروقات · مفتوحة الآن: 3',
      'طلبات من مال المالك اليوم: 2 بقيمة $12.50 من سقف $100.00',
    ]) {
      expect(text).toContain(line);
    }
    // S13 NT2: the nightly run's state, or none yet.
    const line = (reconciliation: (typeof summary)['reconciliation']) =>
      renderTelegramMessage('daily_summary', { ...summary, reconciliation }, LINKS).text;
    expect(line(null)).toContain('المطابقة الليلية: لم تجرِ بعد');
    expect(line({ date: '2029-12-31', status: 'finished', mismatches: 0, open: 0 })).toContain(
      'المطابقة الليلية 2029-12-31: سليمة ✅ · مفتوحة الآن: 0',
    );
    expect(line({ date: '2029-12-31', status: 'failed', mismatches: 0, open: 1 })).toContain(
      'المطابقة الليلية 2029-12-31: فشلت ❌',
    );
    // No player check today: no validation line (S09).
    expect(
      renderTelegramMessage('daily_summary', { ...summary, validations: [] }, LINKS).text,
    ).not.toContain('التحقق من المعرّف');
  });

  it('render a reconciliation alert: date, urgency, lines and the open count (S13 NT1)', () => {
    const alert: TelegramMessageParams<'reconciliation_alert'> = {
      runId: newId(),
      trigger: 'schedule',
      date: '2030-01-01',
      failed: false,
      urgent: true,
      lines: [
        {
          check: 'journal_balance',
          subject: 'ledger',
          status: 'mismatch',
          currency: null,
          differenceUnits: null,
          offendingCount: 2,
          reason: null,
        },
        {
          check: 'supplier_balance',
          subject: 'supplier:fake',
          status: 'mismatch',
          currency: 'USD',
          differenceUnits: -50 * USD,
          offendingCount: 1,
          reason: null,
        },
        {
          check: 'sham_cash_count',
          subject: 'sham_cash_syp',
          status: 'mismatch',
          currency: 'SYP',
          differenceUnits: 1_300_000,
          offendingCount: 1,
          reason: null,
        },
        {
          check: 'usdt_balance',
          subject: 'usdt_bep20',
          status: 'skipped',
          currency: 'USD',
          differenceUnits: null,
          offendingCount: 0,
          reason: 'opening_missing',
        },
        {
          check: 'usdt_balance',
          subject: 'usdt_trc20',
          status: 'skipped',
          currency: 'USD',
          differenceUnits: null,
          offendingCount: 0,
          reason: 'reader_failed',
        },
        {
          check: 'order_conflicts',
          subject: 'orders',
          status: 'warning',
          currency: null,
          differenceUnits: null,
          offendingCount: 3,
          reason: null,
        },
        {
          check: 'count_stale',
          subject: 'sham_cash',
          status: 'warning',
          currency: null,
          differenceUnits: null,
          offendingCount: 1,
          reason: null,
        },
      ],
      moreLines: 4,
      open: 5,
    };
    expect(renderTelegramMessage('reconciliation_alert', alert, LINKS).text.split('\n')).toEqual([
      '⚠️ عاجل: 🧮 المطابقة 2030-01-01: مشكلات جديدة',
      '• توازن القيود: 2 مخالفة',
      '• رصيد المورد (المورد التجريبي): الفرق -$50.00',
      '• جرد شام كاش (شام كاش ل.س): الفرق +13,000 ل.س',
      '• رصيد USDT (USDT BEP20): لا رصيد افتتاحي',
      '• رصيد USDT (USDT TRC20): تعذّرت قراءة الرصيد',
      '• تعارضات الطلبات: 3 طلب',
      '• جرد شام كاش متأخر',
      'و4 أخرى',
      'فروقات مفتوحة الآن: 5',
      'http://127.0.0.1:5173/reconciliation',
    ]);
    const failed = renderTelegramMessage(
      'reconciliation_alert',
      { ...alert, failed: true, urgent: false, lines: [], moreLines: 0 },
      LINKS,
    ).text;
    expect(failed.split('\n')[0]).toBe('❌ فشلت المطابقة 2030-01-01');
  });

  it('render a ticket notice with its number, type, subject and email, never the message (S12 TK8)', () => {
    const ticket = {
      ticketId: newId(),
      number: 'VT-7KQ2MX',
      category: 'order' as const,
      subject: 'أين طلبي؟',
      hasImages: true,
      customerEmail: 'a@example.com',
    };
    const opened = renderTelegramMessage('ticket_opened', ticket, LINKS).text;
    expect(opened).toContain('تذكرة جديدة VT-7KQ2MX · طلب');
    expect(opened).toContain('أين طلبي؟');
    expect(opened).toContain('a@example.com · مع صور');
    expect(opened).toContain(`/support/${ticket.ticketId}`);
    const reply = renderTelegramMessage(
      'ticket_reply',
      { ...ticket, hasImages: false },
      LINKS,
    ).text;
    expect(reply).toContain('ردّ العميل على التذكرة VT-7KQ2MX');
    expect(reply).not.toContain('مع صور');
    expect(opened).not.toContain('المشكلة');
    // S22 OP6: the problem a ticket names.
    expect(
      renderTelegramMessage('ticket_opened', { ...ticket, orderProblem: 'code_used' }, LINKS).text,
    ).toContain('المشكلة: الكود مستخدم مسبقاً');
  });

  it('render a ticket subject as code, so a link in it is never clickable (A07-24)', () => {
    const subject = 'ادخل https://evil.example/login @someone';
    const message = renderTelegramMessage(
      'ticket_opened',
      {
        ticketId: newId(),
        number: 'VT-7KQ2MX',
        category: 'other' as const,
        subject,
        hasImages: false,
        customerEmail: 'a@example.com',
      },
      LINKS,
    );
    const [span] = message.codeSpans ?? [];
    expect(span && message.text.slice(span.offset, span.offset + span.length)).toBe(subject);
  });

  it('render a purchase from the panel with its mode and the owner cap, never fields (S16 AP13)', () => {
    const order = {
      orderId: newId(),
      orderNumber: 'VO-7KQ2MX',
      purpose: 'walk_in' as const,
      gameNameAr: 'ببجي',
      productNameAr: '660 شدة',
      quantity: 1,
      totalUsdUnits: 9_900_000,
      owner: { usedUsdUnits: 19_900_000, capUsdUnits: 100_000_000 },
    };
    const text = renderTelegramMessage('admin_order_placed', order, LINKS).text;
    expect(text).toContain('شراء من اللوحة VO-7KQ2MX · زبون مباشر');
    expect(text).toContain('ببجي · 660 شدة × 1 · $9.90');
    expect(text).toContain('مال المالك اليوم: $19.90 من $100.00');
    expect(text).toContain(`/orders/${order.orderId}`);
    const onBehalf = renderTelegramMessage(
      'admin_order_placed',
      { ...order, purpose: 'on_behalf', owner: null },
      LINKS,
    ).text;
    expect(onBehalf).toContain('بطلب زبون من محفظته');
    expect(onBehalf).not.toContain('مال المالك');
  });

  it('render the decision questions and answers (rules TC4, TC5)', () => {
    const promptId = newId();
    const reply = (params: TelegramMessageParams<'bot_reply'>) =>
      renderTelegramMessage('bot_reply', params, LINKS);
    expect(reply({ reply: 'approve_number', referenceCode: 'VD-7KQ2M' }).text).toContain(
      'أرسل رقم عملية شام كاش لـ VD-7KQ2M',
    );
    expect(
      reply({
        reply: 'approve_confirm',
        promptId,
        referenceCode: 'VD-7KQ2M',
        creditedUsdUnits: 20 * USD,
        transactionNumber: '1234',
      }),
    ).toEqual({
      text: 'اعتماد VD-7KQ2M: إضافة $20.00 برقم العملية 1234؟',
      buttons: [
        [
          { text: 'تأكيد', data: `ok:${promptId}` },
          { text: 'إلغاء', data: `no:${promptId}` },
        ],
      ],
    });
    const reasons = reply({
      reply: 'reject_reasons',
      promptId,
      referenceCode: 'VD-7KQ2M',
      reasons: ['not_received', 'wrong_account'],
    });
    expect(reasons.buttons).toEqual([
      [{ text: 'لم يصل التحويل', data: `rr:${promptId}:not_received` }],
      [{ text: 'التحويل إلى حساب آخر', data: `rr:${promptId}:wrong_account` }],
      [{ text: 'إلغاء', data: `no:${promptId}` }],
    ]);
    expect(
      reply({ reply: 'decision_refused', referenceCode: 'VD-7KQ2M', refusal: 'reference_taken' })
        .text,
    ).toBe('VD-7KQ2M: رقم العملية مستخدم سابقاً، راجع من اللوحة.');
    expect(
      reply({ reply: 'decision_refused', referenceCode: 'VD-7KQ2M', refusal: 'changed' }).text,
    ).toContain('البطاقة الجديدة');
    expect(
      reply({ reply: 'approved', referenceCode: 'VD-7KQ2M', creditedUsdUnits: USD }).text,
    ).toContain('✅');
    expect(
      reply({ reply: 'rejected', referenceCode: 'VD-7KQ2M', reason: 'receipt_used' }).text,
    ).toContain('❌');
    expect(
      reply({ reply: 'reject_note', referenceCode: 'VD-7KQ2M', reason: 'other' }).text,
    ).toContain('ملاحظة داخلية');
    expect(reply({ reply: 'invalid_answer', field: 'note' }).text).toContain('500');
    expect(reply({ reply: 'invalid_answer', field: 'transaction_number' }).text).toContain('64');
  });

  it('render a USDT review card with Reject only (rule TC3)', () => {
    const card = renderDepositCard(
      {
        id: newId(),
        referenceCode: 'VD-7KQ2M',
        method: 'usdt_bep20',
        currency: 'USD',
        declaredAmountUnits: 25 * USD,
        declaredUsdUnits: 25 * USD,
        rate: null,
        customerName: 'سامر',
        creditedCount: 2,
        flags: ['amount_mismatch'],
        submittedAt: new Date('2030-01-01T07:00:00Z'),
        approval: { refusal: 'panel_only' },
        usdt: {
          receivedUnits: 24_003_700,
          expectedUnits: 25_003_700,
          txid: 'ab'.repeat(32),
          transferMethod: 'usdt_bep20',
        },
        outcome: null,
      },
      LINKS,
    );
    expect(card.text).toContain('المستلم 24.0037 USDT، المطلوب 25.0037');
    expect(card.text).toContain('https://bscscan.com/tx/0x');
    expect(card.text).not.toContain('وصل على');
    expect(card.text).toContain('2 إيداعات سابقة');
    expect(card.text).toContain('مبلغ مختلف');
    expect(card.buttons?.flat().map((button) => button.text)).toEqual(['رفض']);
  });

  it('name the network a wrong-network transfer is on, and link its explorer (audit A6)', () => {
    const view = (method: 'usdt_trc20' | 'usdt_bep20', transferMethod: typeof method) =>
      renderDepositCard(
        {
          id: newId(),
          referenceCode: 'VD-7KQ2M',
          method,
          currency: 'USD',
          declaredAmountUnits: 25 * USD,
          declaredUsdUnits: 25 * USD,
          rate: null,
          customerName: 'سامر',
          creditedCount: 2,
          flags: ['wrong_network'],
          submittedAt: new Date('2030-01-01T07:00:00Z'),
          approval: { refusal: 'panel_only' },
          usdt: {
            receivedUnits: 25_003_700,
            expectedUnits: 25_003_700,
            txid: 'ab'.repeat(32),
            transferMethod,
          },
          outcome: null,
        },
        LINKS,
      ).text;
    const onBsc = view('usdt_trc20', 'usdt_bep20');
    expect(onBsc).toContain('وصل على USDT BEP20، والإيداع على USDT TRC20');
    expect(onBsc).toContain('https://bscscan.com/tx/0x');
    expect(onBsc).not.toContain('tronscan');
    const onTron = view('usdt_bep20', 'usdt_trc20');
    expect(onTron).toContain('وصل على USDT TRC20، والإيداع على USDT BEP20');
    expect(onTron).toContain('https://tronscan.org/#/transaction/');
  });
});

describe('the alert channel (rule AL3)', () => {
  it('counts the alerts it held back per Damascus day', async () => {
    const alerts = new TelegramAlerts(
      { source: 'test' },
      { configured: true, call: async () => null },
      async () => 1,
    );
    const noon = Date.parse('2030-01-01T09:00:00Z');
    await alerts.send('same', noon);
    await alerts.send('same', noon + 1000);
    await alerts.send('same', noon + 2000);
    expect(alerts.suppressedOn('2030-01-01')).toBe(2);
    expect(alerts.suppressedOn('2030-01-02')).toBe(0);
  });
});
