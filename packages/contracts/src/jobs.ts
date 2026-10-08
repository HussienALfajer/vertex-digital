import { z } from 'zod';
import { usdtMethodSchema } from './usdt.js';

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
  /** Reads a network's incoming USDT transfers and credits exact matches (S04 rule U12). */
  depositsUsdtScan: 'deposits.usdt-scan',
  /** Verifies one USDT deposit's TXID (S04 rules U9–U11). */
  depositsUsdtVerify: 'deposits.usdt-verify',
} as const;

/**
 * Queues that keep one job per `singletonKey` queued and one active (pg-boss `stately`): a USDT
 * deposit's verification and a network's scan run one at a time, and a running job can queue its
 * successor (S04 rules U9, U12). The API and the worker create queues with these policies.
 */
export const QUEUE_POLICIES: Readonly<Record<string, 'stately'>> = {
  [QUEUES.depositsUsdtScan]: 'stately',
  [QUEUES.depositsUsdtVerify]: 'stately',
};

export const emailSendPayloadSchema = z.object({ outboxId: z.uuid() });

export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;

export const depositsUsdtScanPayloadSchema = z.object({ method: usdtMethodSchema });

export type DepositsUsdtScanPayload = z.infer<typeof depositsUsdtScanPayloadSchema>;

export const depositsUsdtVerifyPayloadSchema = z.object({ depositId: z.uuid() });

export type DepositsUsdtVerifyPayload = z.infer<typeof depositsUsdtVerifyPayloadSchema>;
