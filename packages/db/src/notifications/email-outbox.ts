import {
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_PARAMS,
  type EmailParams,
  type EmailTemplate,
  isCodeEmail,
  QUEUES,
} from '@vertex-digital/contracts';
import type { PgBoss, SendOptions } from 'pg-boss';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { transactionExecutor } from '../jobs.js';
import { emailOutbox } from '../schema/index.js';

/**
 * Sends a job in the caller's transaction: the API's `JobsService`, or `bossJobSender` in the
 * worker. The job exists only if the transaction commits.
 */
export interface JobSender {
  send(tx: Transaction, queue: string, data: object, options?: SendOptions): Promise<unknown>;
}

/** A `JobSender` over a started pg-boss instance whose queues exist (the worker). */
export function bossJobSender(boss: PgBoss): JobSender {
  return {
    send: (tx, queue, data, options = {}) =>
      boss.send(queue, data, { ...options, db: transactionExecutor(tx) }),
  };
}

export interface EmailInput<Template extends EmailTemplate> {
  to: string;
  template: Template;
  params: EmailParams<Template>;
  /** The customer the email is about, for the support history. */
  customerId?: string | null;
}

/** pg-boss priority: code emails go first (ADR 0007, rule E2). */
const PRIORITY = { high: 10, normal: 0 } as const;

/**
 * The email outbox (S01 rules E1–E5): every email is an `email_outbox` row and an `email.send`
 * job, written in the caller's transaction, so an email exists only if the change that causes it
 * commits. Neither the API nor `notifyCustomer` talks to SMTP; the worker sends.
 */
export async function queueEmail<Template extends EmailTemplate>(
  tx: Transaction,
  jobs: JobSender,
  email: EmailInput<Template>,
): Promise<string> {
  const code = isCodeEmail(email.template);
  const priority = code ? 'high' : 'normal';
  const id = newId();
  await tx.insert(emailOutbox).values({
    id,
    toAddress: email.to,
    template: email.template,
    params: EMAIL_PARAMS[email.template].parse(email.params),
    priority,
    customerId: email.customerId ?? null,
    expiresAt: code ? new Date(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000) : null,
  });
  await jobs.send(
    tx,
    QUEUES.emailSend,
    { outboxId: id },
    {
      priority: PRIORITY[priority],
      // Five retries from 10 seconds, doubling (rule E2 stops code emails once they expire).
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
    },
  );
  return id;
}
