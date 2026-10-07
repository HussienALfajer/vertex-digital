import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type EmailTemplate, QUEUES } from '@vertex-digital/contracts';
import { type Database, emailOutbox, newId } from '@vertex-digital/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/database/database.module.js';
import type { Mailer } from '../src/core/email/mailer.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { PurgeCodesJob } from '../src/jobs/email/purge-codes.job.js';
import { MAX_EMAIL_ATTEMPTS, SendEmailJob } from '../src/jobs/email/send-email.job.js';
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
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 1, params: null });
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
          throw new Error('SMTP connection refused');
        },
      } as unknown as Mailer,
      db,
    );
    await expect(failing.send(id)).rejects.toThrow('SMTP connection refused');
    expect(await rowOf(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Error: SMTP connection refused',
    });
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
