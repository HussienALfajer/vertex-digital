import { z } from 'zod';

/*
 * Queues shared by the API (which sends jobs) and the worker (which works them), named
 * `<area>.<action>`. Payloads carry ids, never records: the job loads fresh data.
 */

export const QUEUES = {
  /** Sends one `email_outbox` row (S01, rule E1). */
  emailSend: 'email.send',
  /** Clears the code of code emails whose code expired (rule E4), every 10 minutes. */
  emailPurgeCodes: 'email.purge-codes',
  /** Moves `pending` deposits past `expires_at` to `expired` (S03 rule SC12), every 5 minutes. */
  depositsExpire: 'deposits.expire',
} as const;

export const emailSendPayloadSchema = z.object({ outboxId: z.uuid() });

export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;
