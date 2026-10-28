import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type EmailTemplate, QUEUES } from '@vertex-digital/contracts';
import { type Database, emailOutbox, newId, telegramMessages } from '@vertex-digital/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/core/config/env.js';
import { DATABASE } from '../src/core/database/database.module.js';
import { Mailer, SMTP_TIMEOUTS } from '../src/core/email/mailer.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { renderEmail } from '../src/jobs/email/email-templates.js';
import { PurgeCodesJob } from '../src/jobs/email/purge-codes.job.js';
import { MAX_EMAIL_ATTEMPTS, SendEmailJob } from '../src/jobs/email/send-email.job.js';
import { PurgeOutboxesJob } from '../src/jobs/system/purge-outboxes.job.js';
import { WorkerModule } from '../src/worker.module.js';

/*
 * Email (S01 rules E1–E5) against the test database, in log mode: each sent email is an `.eml`
 * file in a directory of its own per run (vitest.config.ts). Nothing reaches an SMTP server.
 */

const logDir = resolve(process.env.EMAIL_LOG_DIR as string);
const MINUTE = 60 * 1000;

let app: INestApplicationContext;
let db: Database;
let job: SendEmailJob;
const rows: string[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  app = await moduleRef.init();
  db = app.get<Database>(DATABASE);
  job = app.get(SendEmailJob);
  // The API tests queue email jobs no worker runs; their outbox rows are gone. Clear the backlog.
  await app.get(PgBossService).boss.deleteQueuedJobs(QUEUES.emailSend);
});

afterAll(async () => {
  if (rows.length > 0) await db.delete(emailOutbox).where(inArray(emailOutbox.id, rows));
  await app.close();
});

async function queue(
  template: EmailTemplate,
  params: Record<string, unknown>,
  expiresAt: Date | null = null,
): Promise<string> {
  const id = newId();
  rows.push(id);
  await db.insert(emailOutbox).values({
    id,
    toAddress: `${id}@test.vertex-digital.local`,
    template,
    params,
    priority: expiresAt ? 'high' : 'normal',
    expiresAt,
  });
  return id;
}

const rowOf = async (id: string) =>
  (await db.select().from(emailOutbox).where(eq(emailOutbox.id, id)))[0];

const filesOf = async (id: string) =>
  (await readdir(logDir).catch(() => [] as string[])).filter((name) => name.endsWith(`${id}.eml`));

/** F11-8: Latin values sit in Unicode isolates inside the Arabic sentences. */
const ltr = (value: string) => `\u2066${value}\u2069`;
const named = (value: string) => `\u2068${value}\u2069`;

describe('the wallet adjustment email (S02)', () => {
  const params = {
    at: '2026-10-07T09:30:00.000Z',
    direction: 'credit',
    amountUnits: 25_000_000,
    category: 'compensation',
    reversal: false,
  } as const;

  it('says how much moved, which way and why, with a link to the wallet page', () => {
    const email = renderEmail('customer_wallet_adjusted', params, 'https://digital.example');
    expect(email.subject).toBe(`أُضيف ${ltr('$25.00')} إلى رصيدك`);
    expect(email.text).toContain('نوع الحركة: تعويض.');
    expect(email.text).toContain('عرض المحفظة: https://digital.example/wallet');
    expect(email.html).toContain('href="https://digital.example/wallet"');
  });

  it('names a debit and a reversal', () => {
    const email = renderEmail(
      'customer_wallet_adjusted',
      { ...params, direction: 'debit', amountUnits: 1_234_500_000, reversal: true },
      'http://127.0.0.1:3001',
    );
    expect(email.subject).toBe(`خُصم ${ltr('$1,234.50')} من رصيدك`);
    expect(email.text).toContain('نوع الحركة: عكس: تعويض.');
  });
});

describe('the merchant approval email (S20 MA5)', () => {
  it('names the kind of price the approval set, not always merchant prices (A06-27)', () => {
    const special = renderEmail(
      'customer_merchant_approved',
      { priceKind: 'special' },
      'https://digital.example',
    );
    expect(special.text).toContain('وتظهر لك أسعار خاصة في صفحات الألعاب.');
    const retail = renderEmail(
      'customer_merchant_approved',
      { priceKind: 'retail' },
      'https://digital.example',
    );
    expect(retail.text).toContain('وتظهر لك أسعار التجزئة في صفحات الألعاب.');
  });
});

describe('the deposit emails (S03)', () => {
  const depositId = '01890000-0000-7000-8000-0000000000d1';
  const store = 'https://digital.example';
  const link = `https://digital.example/wallet/deposits/${depositId}`;
  const arabicRtl = (html: string) => expect(html).toContain('<html lang="ar" dir="rtl">');

  it('says how much was credited, with a link to the deposit', () => {
    const email = renderEmail(
      'customer_deposit_credited',
      {
        at: '2026-10-08T09:30:00.000Z',
        depositId,
        referenceCode: 'VD-7KQ2M',
        creditedUsdUnits: 16_100_000,
      },
      store,
    );
    expect(email.subject).toBe(`أُضيف ${ltr('$16.10')} إلى رصيدك من إيداعك ${ltr('VD-7KQ2M')}`);
    expect(email.text).toContain('VD-7KQ2M');
    expect(email.text).toContain(`عرض الإيداع: ${link}`);
    arabicRtl(email.html);
  });

  it('gives the reason of a rejection in words, never a note', () => {
    const email = renderEmail(
      'customer_deposit_rejected',
      { depositId, referenceCode: 'VD-7KQ2M', reason: 'receipt_invalid' },
      store,
    );
    expect(email.text).toContain('السبب: الإيصال غير صالح أو معدَّل.');
    expect(email.html).toContain(`href="${link}"`);
    arabicRtl(email.html);
    const other = renderEmail(
      'customer_deposit_rejected',
      { depositId, referenceCode: 'VD-7KQ2M', reason: 'other' },
      store,
    );
    expect(other.text).toContain('موضَّح في صفحة الإيداع');
  });

  it('asks for a clearer receipt with a link to the deposit', () => {
    const email = renderEmail(
      'customer_deposit_receipt_requested',
      { depositId, referenceCode: 'VD-7KQ2M' },
      store,
    );
    expect(email.subject).toBe(`نحتاج إيصالًا أوضح لإيداعك ${ltr('VD-7KQ2M')}`);
    expect(email.text).toContain(`عرض الإيداع: ${link}`);
    arabicRtl(email.html);
  });
});

describe('the order emails (S08)', () => {
  const orderId = '01890000-0000-7000-8000-0000000000e1';
  const store = 'https://digital.example';
  const link = `https://digital.example/orders/${orderId}`;
  const order = {
    at: '2026-10-09T09:30:00.000Z',
    orderId,
    orderNumber: 'VO-7KQ2MX',
    productNameAr: '60 UC',
  };

  it('says the order was delivered, with a link to it and no codes', () => {
    const email = renderEmail('customer_order_delivered', { ...order, quantity: 2 }, store);
    expect(email.subject).toBe(`سُلّم طلبك ${ltr('VO-7KQ2MX')}`);
    expect(email.text).toContain(`(${named('60 UC')} × 2)`);
    // The number stays whole on one line in the HTML, its parts never split at the hyphen.
    expect(email.html).toContain(
      `<span dir="ltr" style="white-space:nowrap">${ltr('VO-7KQ2MX')}</span> (${named('60 UC')} × 2)`,
    );
    expect(email.text).toContain(`عرض الطلب: ${link}`);
  });

  it('says how much was refunded and why', () => {
    const partial = renderEmail(
      'customer_order_partially_refunded',
      { ...order, deliveredQuantity: 2, refundedQuantity: 1, refundedUsdUnits: 9_600_000 },
      store,
    );
    expect(partial.text).toContain(`أُعيد ${ltr('$9.60')} إلى رصيد محفظتك`);
    const full = renderEmail(
      'customer_order_refunded',
      { ...order, refundedUsdUnits: 1_230_000, reason: 'input_rejected' },
      store,
    );
    expect(full.subject).toBe(`أُعيد ${ltr('$1.23')} إلى رصيدك عن الطلب ${ltr('VO-7KQ2MX')}`);
    expect(full.text).toContain('السبب: بيانات الحساب مرفوضة.');
    expect(full.html).toContain(`href="${link}"`);
  });

  it('says why a reservation was cancelled, with nothing taken (S09 rule RS9)', () => {
    const email = renderEmail('customer_order_cancelled', { ...order, reason: 'expired' }, store);
    expect(email.subject).toBe(`أُلغي طلبك المحجوز ${ltr('VO-7KQ2MX')}`);
    expect(email.text).toContain('السبب: انتهت مدة الحجز (24 ساعة).');
    expect(email.text).toContain('لم يُخصم من رصيدك شيء');
    expect(email.html).toContain(`href="${link}"`);
  });

  it('sums up a finished checkout with its refund, never fields (S10 rule CT8)', () => {
    const checkoutId = '01920000-0000-7000-8000-000000000099';
    const email = renderEmail(
      'customer_checkout_finished',
      {
        at: order.at,
        checkoutId,
        orderCount: 5,
        delivered: 3,
        partiallyRefunded: 1,
        refunded: 1,
        refundedUsdUnits: 2_500_000,
      },
      store,
    );
    expect(email.subject).toBe('اكتملت سلتك: سُلّم 3، سُلّم جزئياً 1، استُرد 1');
    expect(email.text).toContain(`أُعيد ${ltr('$2.50')} إلى رصيد محفظتك`);
    expect(email.html).toContain(`href="${store}/orders?checkout=${checkoutId}"`);
    const clean = renderEmail(
      'customer_checkout_finished',
      {
        at: order.at,
        checkoutId,
        orderCount: 2,
        delivered: 2,
        partiallyRefunded: 0,
        refunded: 0,
        refundedUsdUnits: 0,
      },
      store,
    );
    expect(clean.subject).toBe('اكتملت سلتك: سُلّم 2');
    expect(clean.text).not.toContain('أُعيد');
  });
});

describe('email.send', () => {
  it('writes a code email to a file in Arabic, right to left, and clears the code', async () => {
    const id = await queue(
      'customer_verify_email',
      { code: '482913' },
      new Date(Date.now() + 10 * MINUTE),
    );
    expect(await job.send(id)).toBe('sent');
    const [file] = await filesOf(id);
    expect(file).toBeDefined();
    const message = await readFile(join(logDir, file as string), 'utf8');
    expect(message).toContain('482913');
    expect(message).toContain('dir=3D"rtl"');
    expect(message).toMatch(/Subject: =\?UTF-8\?/);
    // The brand logo travels inside the email, named by the HTML (F2-5).
    expect(message).toContain('cid:logo@vertex-digital');
    expect(message).toContain('Content-ID: <logo@vertex-digital>');
    expect(message).toContain('Content-Disposition: inline');
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 1, params: null });
  });

  it('names an unknown device in Arabic in the sign-in email', () => {
    const email = renderEmail(
      'customer_new_sign_in',
      { at: '2026-10-07T09:30:00.000Z', browser: 'Unknown', system: 'Unknown', ipAddress: null },
      'https://digital.example',
    );
    expect(email.text).toContain('الجهاز: غير معروف على غير معروف.');
    expect(email.text).not.toContain('Unknown');
  });

  it('writes the passkey email with its name, device and address (S22 PK2)', () => {
    const email = renderEmail(
      'customer_passkey_added',
      {
        at: '2026-10-25T09:30:00.000Z',
        name: 'iOS · Safari',
        browser: 'Safari',
        system: 'iOS',
        ipAddress: '203.0.113.7',
      },
      'https://digital.example',
    );
    expect(email.subject).toBe('أُضيفت بصمة دخول إلى حسابك');
    expect(email.text).toContain('«iOS · Safari»');
    expect(email.text).toContain('203.0.113.7');
    expect(email.text).toContain('نسيت كلمة المرور');
  });

  it('frames every email in the brand: the logo, the title and the store address', () => {
    const email = renderEmail(
      'customer_new_sign_in',
      {
        at: '2026-10-07T09:30:00.000Z',
        browser: 'Chrome',
        system: 'Android',
        ipAddress: '203.0.113.7',
      },
      'https://digital.example',
    );
    expect(email.html).toContain('src="cid:logo@vertex-digital"');
    expect(email.html).toContain('#004139');
    expect(email.html).toContain('>تسجيل دخول جديد إلى حسابك</h1>');
    expect(email.html).toContain('href="https://digital.example"');
    expect(email.text.startsWith('تسجيل دخول جديد إلى حسابك')).toBe(true);
    expect(email.attachments).toEqual([
      {
        cid: 'logo@vertex-digital',
        path: expect.stringMatching(/vertex-logo-gold\.png$/),
        filename: 'vertex-digital.png',
      },
    ]);
  });

  it('writes the wallet adjustment email with its link', async () => {
    const id = await queue('customer_wallet_adjusted', {
      at: new Date().toISOString(),
      direction: 'credit',
      amountUnits: 25_000_000,
      category: 'test_funds',
      reversal: false,
    });
    expect(await job.send(id)).toBe('sent');
    const [file] = await filesOf(id);
    const message = await readFile(join(logDir, file as string), 'utf8');
    expect(message).toContain('/wallet');
  });

  it('sends once when run twice', async () => {
    const id = await queue('customer_sign_up_attempt', {});
    expect(await job.send(id)).toBe('sent');
    expect(await job.send(id)).toBe('skipped');
    expect(await filesOf(id)).toHaveLength(1);
    // Not a code email: its parameters stay.
    expect((await rowOf(id))?.params).toEqual({});
  });

  it('never sends a code email after its code expired (rule E2)', async () => {
    const id = await queue('customer_reset_password', { code: '111222' }, new Date(Date.now() - 1));
    expect(await job.send(id)).toBe('expired');
    expect(await filesOf(id)).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ status: 'failed', params: null });
  });

  it('records a failure and throws for a retry, then fails for good after the last attempt', async () => {
    const id = await queue('customer_password_changed', { at: new Date().toISOString() });
    const failing = new SendEmailJob(
      app.get(PgBossService),
      {
        send: async () => {
          // As Nodemailer rejects a recipient: the server's text names the customer.
          throw Object.assign(
            new Error("Can't send mail - all recipients were rejected: 550 <someone@example.com>"),
            { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 },
          );
        },
      } as unknown as Mailer,
      db,
      app.get<Env>(ENV),
    );
    const thrown = (await failing.send(id).catch((error: unknown) => error)) as Error;
    // Only the code, the command and the status reach the logs, Sentry and the alert channel.
    expect(thrown.message).toBe('SMTP send failed (code EENVELOPE, command RCPT TO, status 550)');
    expect(await rowOf(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'EmailSendError: SMTP send failed (code EENVELOPE, command RCPT TO, status 550)',
    });
    expect(JSON.stringify(await rowOf(id))).not.toContain('someone@example.com');
    for (let attempt = 2; attempt <= MAX_EMAIL_ATTEMPTS; attempt += 1) {
      await expect(failing.send(id)).rejects.toThrow();
    }
    expect(await rowOf(id)).toMatchObject({ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS });
    expect(await failing.send(id)).toBe('skipped');
  });

  it('works a queued job', async () => {
    const id = await queue('customer_new_sign_in', {
      at: new Date().toISOString(),
      browser: 'Chrome',
      system: 'Android',
      ipAddress: '10.0.0.1',
    });
    // Above every job the API sends (code emails are 10): in CI the API tests queue code emails
    // into the same test database at the same time, and they would go first.
    await app.get(PgBossService).boss.send(QUEUES.emailSend, { outboxId: id }, { priority: 100 });
    await expect.poll(async () => (await rowOf(id))?.status, { timeout: 25_000 }).toBe('sent');
    const message = await readFile(join(logDir, (await filesOf(id))[0] as string), 'utf8');
    expect(message).toContain('Chrome');
  });
});

describe('email.purge-codes (rule E4)', () => {
  it('clears expired codes only', async () => {
    const expired = await queue(
      'customer_change_email',
      { code: '333444' },
      new Date(Date.now() - MINUTE),
    );
    const fresh = await queue(
      'customer_change_email',
      { code: '555666' },
      new Date(Date.now() + 10 * MINUTE),
    );
    const notice = await queue('customer_email_changed', { at: new Date().toISOString() });
    expect(await app.get(PurgeCodesJob).purge()).toBeGreaterThanOrEqual(1);
    expect((await rowOf(expired))?.params).toBeNull();
    expect((await rowOf(fresh))?.params).toEqual({ code: '555666' });
    expect((await rowOf(notice))?.params).not.toBeNull();
    // Running it again changes nothing for these rows.
    await app.get(PurgeCodesJob).purge();
    expect((await rowOf(fresh))?.params).toEqual({ code: '555666' });
  });

  it('is scheduled every 10 minutes', async () => {
    expect(await app.get(PgBossService).boss.getSchedules(QUEUES.emailPurgeCodes)).toEqual([
      expect.objectContaining({ cron: '*/10 * * * *' }),
    ]);
  });
});

describe('system.purge-outboxes (Q29, audit A10-46)', () => {
  it('clears a settled email’s address and parameters and a message’s parameters after the retention', async () => {
    const old = sql`now() - interval '91 days'`;
    const settledOld = await queue('customer_email_changed', { at: new Date().toISOString() });
    const settledNew = await queue('customer_email_changed', { at: new Date().toISOString() });
    const pendingOld = await queue('customer_email_changed', { at: new Date().toISOString() });
    await db
      .update(emailOutbox)
      .set({ status: 'sent', sentAt: new Date(), updatedAt: old })
      .where(eq(emailOutbox.id, settledOld));
    await db.update(emailOutbox).set({ status: 'sent' }).where(eq(emailOutbox.id, settledNew));
    await db.update(emailOutbox).set({ updatedAt: old }).where(eq(emailOutbox.id, pendingOld));
    const message = (kind: 'ticket_opened' | 'supplier_health', params: Record<string, unknown>) =>
      db
        .insert(telegramMessages)
        .values({ id: newId(), kind, params, status: 'sent', createdAt: old })
        .returning({ id: telegramMessages.id })
        .then(([row]) => row?.id as string);
    const ticket = await message('ticket_opened', { number: 'T-1' });
    const health = await message('supplier_health', { supplier: 'fake', state: 'down' });
    try {
      await app.get(PurgeOutboxesJob).purge();
      expect(await rowOf(settledOld)).toMatchObject({ toAddress: null, params: null });
      expect((await rowOf(settledNew))?.toAddress).not.toBeNull();
      expect((await rowOf(pendingOld))?.toAddress).not.toBeNull();
      const params = async (id: string) =>
        (await db.select().from(telegramMessages).where(eq(telegramMessages.id, id)))[0]?.params;
      expect(await params(ticket)).toEqual({});
      // The newest state told per supplier is read by the health job: kept.
      expect(await params(health)).toEqual({ supplier: 'fake', state: 'down' });
    } finally {
      await db.delete(telegramMessages).where(inArray(telegramMessages.id, [ticket, health]));
    }
  });

  it('is scheduled daily at 04:30 Damascus', async () => {
    expect(await app.get(PgBossService).boss.getSchedules(QUEUES.systemPurgeOutboxes)).toEqual([
      expect.objectContaining({ cron: '30 4 * * *', timezone: 'Asia/Damascus' }),
    ]);
  });
});

describe('the SMTP transport', () => {
  it('gives up on a hung server in seconds, not minutes (A07-29)', () => {
    const mailer = new Mailer({
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: 2525,
      SMTP_SECURE: false,
      SMTP_USER: 'user',
      SMTP_PASSWORD: 'password',
    } as Env);
    const options = (mailer as unknown as { transport: { options: Record<string, unknown> } })
      .transport.options;
    expect(options).toMatchObject(SMTP_TIMEOUTS);
    expect(SMTP_TIMEOUTS.socketTimeout).toBeLessThanOrEqual(30_000);
  });
});
