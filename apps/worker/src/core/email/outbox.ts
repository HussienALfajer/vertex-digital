import {
  EMAIL_PARAMS,
  type EmailParams,
  type EmailTemplate,
  isCodeEmail,
  QUEUES,
} from '@vertex-digital/contracts';
import { emailOutbox, newId, type Transaction, transactionExecutor } from '@vertex-digital/db';
import type { PgBoss } from 'pg-boss';

export interface OutboxEmail<Template extends EmailTemplate> {
  to: string;
  template: Template;
  params: EmailParams<Template>;
  customerId: string | null;
}

/**
 * Queues an email from a worker job (S01 rules E1, E2), as the API's `NotificationsService` does:
 * an `email_outbox` row and its `email.send` job in the caller's transaction, so the email exists
 * only if the change that causes it commits. Not for code emails, which only the API sends.
 */
export async function queueEmail<Template extends EmailTemplate>(
  tx: Transaction,
  boss: PgBoss,
  email: OutboxEmail<Template>,
): Promise<string> {
  if (isCodeEmail(email.template)) throw new Error('Code emails are sent by the API');
  const id = newId();
  await tx.insert(emailOutbox).values({
    id,
    toAddress: email.to,
    template: email.template,
    params: EMAIL_PARAMS[email.template].parse(email.params),
    priority: 'normal',
    customerId: email.customerId,
    expiresAt: null,
  });
  await boss.send(
    QUEUES.emailSend,
    { outboxId: id },
    // As the API: five retries from 10 seconds, doubling (rule E2).
    { retryLimit: 5, retryDelay: 10, retryBackoff: true, db: transactionExecutor(tx) },
  );
  return id;
}
