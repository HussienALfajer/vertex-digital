import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  EMAIL_PARAMS,
  type EmailSendPayload,
  emailSendPayloadSchema,
  isCodeEmail,
  QUEUES,
} from '@vertex-digital/contracts';
import { type Database, emailOutbox } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { Mailer } from '../../core/email/mailer.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { renderEmail } from './email-templates.js';

/** The first send and the five retries the API asks pg-boss for (rule E2). */
export const MAX_EMAIL_ATTEMPTS = 6;

export type SendOutcome = 'sent' | 'skipped' | 'expired';

/**
 * A failed send as the logs, Sentry, the alert channel and `last_error` may see it: Nodemailer's
 * error code, the SMTP command and the SMTP status only. The server's own text can name the
 * recipient ("550 <name@example.com>: recipient rejected"), so it never leaves this file
 * (2026-10-15 feature 2 audit).
 */
export class EmailSendError extends Error {
  override name = 'EmailSendError';

  static from(error: unknown): EmailSendError {
    const failure = (error ?? {}) as { code?: unknown; command?: unknown; responseCode?: unknown };
    const word = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z_ ]{1,32}$/.test(value) ? value : 'unknown';
    const status =
      typeof failure.responseCode === 'number' && Number.isInteger(failure.responseCode)
        ? failure.responseCode
        : 'none';
    return new EmailSendError(
      `SMTP send failed (code ${word(failure.code)}, command ${word(failure.command)}, status ${status})`,
    );
  }
}

/**
 * `email.send` (S01 rules E1–E5): sends one outbox row. Safe to run twice: the row is locked and
 * sent only while `pending`. A code email past its expiry is marked failed without sending; a
 * sent code email loses its code. A failure is recorded on the row and thrown, so pg-boss retries
 * with backoff and the failure reaches the logs, Sentry and the alert channel; after the last
 * attempt the row is `failed`. A crash between SMTP and the update can send one email twice:
 * accepted for email.
 */
@Injectable()
export class SendEmailJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SendEmailJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly mailer: Mailer,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<EmailSendPayload>(QUEUES.emailSend, async (data) => {
      await this.send(emailSendPayloadSchema.parse(data).outboxId);
    });
    this.logger.log(`Working ${QUEUES.emailSend}`);
  }

  async send(outboxId: string, now = new Date()): Promise<SendOutcome> {
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.id, outboxId))
        .for('update', { skipLocked: true });
      // Missing, being sent by another run, or already settled: nothing to do.
      if (row?.status !== 'pending') return { result: 'skipped' } as const;
      const code = isCodeEmail(row.template);
      if (code && row.expiresAt && row.expiresAt <= now) {
        await tx
          .update(emailOutbox)
          .set({ status: 'failed', params: null, lastError: 'Code expired before sending' })
          .where(eq(emailOutbox.id, row.id));
        return { result: 'expired' } as const;
      }
      // Only a settled email's address is cleared (Q29, `system.purge-outboxes`); a pending row
      // without one was written wrong and is never sent.
      const to = row.toAddress;
      if (to === null) {
        await tx
          .update(emailOutbox)
          .set({ status: 'failed', params: null, lastError: 'No address' })
          .where(eq(emailOutbox.id, row.id));
        return { result: 'expired' } as const;
      }
      const attempts = row.attempts + 1;
      try {
        const params = EMAIL_PARAMS[row.template].parse(row.params);
        await this.mailer.send({
          id: row.id,
          to,
          ...renderEmail(row.template, params as never, this.env.STORE_URL),
        });
      } catch (raw) {
        const error = EmailSendError.from(raw);
        const failed = attempts >= MAX_EMAIL_ATTEMPTS;
        await tx
          .update(emailOutbox)
          .set({
            attempts,
            status: failed ? 'failed' : 'pending',
            lastError: `${error.name}: ${error.message}`.slice(0, 500),
            ...(failed && code && { params: null }),
          })
          .where(eq(emailOutbox.id, row.id));
        return { result: 'error', error } as const;
      }
      await tx
        .update(emailOutbox)
        .set({
          attempts,
          status: 'sent',
          sentAt: now,
          lastError: null,
          // Rule E4: the code leaves the database once its email is sent.
          ...(code && { params: null }),
        })
        .where(eq(emailOutbox.id, row.id));
      return { result: 'sent' } as const;
    });
    if (outcome.result === 'error') throw outcome.error;
    return outcome.result;
  }
}
