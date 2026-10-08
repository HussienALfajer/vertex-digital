import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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
import { and, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { TelegramAlerts } from '../src/core/alerts/telegram-alerts.js';
import type { Env } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { DailySummaryJob, damascusDate } from '../src/jobs/telegram/daily-summary.job.js';
import { DepositCardJob } from '../src/jobs/telegram/deposit-card.job.js';
import { ReviewReminderJob } from '../src/jobs/telegram/review-reminder.job.js';
import { TelegramBot } from '../src/telegram/bot-api.js';
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
          decisionIdempotencyKey: `telegram:${newId()}`,
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
      await tx.insert(telegramUpdates).values({ updateId: old, receivedAt: at('00:00') });
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
        .orderBy(telegramMessages.createdAt)
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
    const job = new DailySummaryJob(pgBoss, alerts, db);
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
          decisionIdempotencyKey: `telegram:${newId()}`,
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
    };
    const text = renderTelegramMessage('daily_summary', summary, LINKS).text;
    for (const line of [
      '• شام كاش: 3 بقيمة $75.00',
      'منها من تيليجرام: 2',
      'التسجيل: مغلق',
      '⛔ الإيداع متوقف منذ 01/01 13:00',
      'تنبيهات حُجبت بحد الإرسال: 3',
    ]) {
      expect(text).toContain(line);
    }
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
        usdt: { receivedUnits: 24_003_700, expectedUnits: 25_003_700, txid: 'ab'.repeat(32) },
        outcome: null,
      },
      LINKS,
    );
    expect(card.text).toContain('المستلم 24.0037 USDT، المطلوب 25.0037');
    expect(card.text).toContain('https://bscscan.com/tx/0x');
    expect(card.text).toContain('2 إيداعات سابقة');
    expect(card.text).toContain('مبلغ مختلف');
    expect(card.buttons?.flat().map((button) => button.text)).toEqual(['رفض']);
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
