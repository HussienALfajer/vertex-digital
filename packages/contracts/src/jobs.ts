import { z } from 'zod';
import { supplierCodeSchema, syncRunTriggerSchema } from './suppliers.js';
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
  /** Sends one `telegram_messages` row to the linked chat (S05 F07). */
  telegramSend: 'telegram.send',
  /** Sends or edits one deposit's card in the linked chat (S05 rules TC1–TC6). */
  telegramDepositCard: 'telegram.deposit-card',
  /** Reminds the admin of overdue reviews, every 5 minutes (S05 rules RM1–RM4). */
  telegramReviewReminder: 'telegram.review-reminder',
  /** The day's summary at 22:30 `Asia/Damascus` (S05 rule AL3). */
  telegramDailySummary: 'telegram.daily-summary',
  /** Reads one supplier's offers and costs (S07 rules SY1–SY4). */
  suppliersSync: 'suppliers.sync',
  /** Queues `suppliers.sync` for each eligible supplier, every 15 minutes (rule SY1). */
  suppliersSyncSchedule: 'suppliers.sync-schedule',
  /** Reads the suppliers' balances, every 5 minutes (rule H5). */
  suppliersBalances: 'suppliers.balances',
  /** The suppliers' health, its probes and stale costs, every minute (rules H1–H4, SY5). */
  suppliersHealth: 'suppliers.health',
} as const;

/**
 * Queues that keep one job per `singletonKey` queued and one active (pg-boss `stately`): a USDT
 * deposit's verification and a network's scan run one at a time, and a running job can queue its
 * successor (S04 rules U9, U12); a deposit's card is sent or edited by one job at a time, which
 * loads the deposit fresh (S05). The API and the worker create queues with these policies.
 */
export const QUEUE_POLICIES: Readonly<Record<string, 'stately'>> = {
  [QUEUES.depositsUsdtScan]: 'stately',
  [QUEUES.depositsUsdtVerify]: 'stately',
  [QUEUES.telegramDepositCard]: 'stately',
};

export const emailSendPayloadSchema = z.object({ outboxId: z.uuid() });

export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;

export const depositsUsdtScanPayloadSchema = z.object({ method: usdtMethodSchema });

export type DepositsUsdtScanPayload = z.infer<typeof depositsUsdtScanPayloadSchema>;

export const depositsUsdtVerifyPayloadSchema = z.object({
  depositId: z.uuid(),
  /**
   * Successful reads that said "not found" so far for the current TXID (rule U9), carried from
   * one run to the next; a re-check or the API's first job starts from zero.
   */
  notFoundReads: z.int().min(0).optional(),
});

export type DepositsUsdtVerifyPayload = z.infer<typeof depositsUsdtVerifyPayloadSchema>;

export const telegramSendPayloadSchema = z.object({ messageId: z.uuid() });

export type TelegramSendPayload = z.infer<typeof telegramSendPayloadSchema>;

/** `singletonKey` is the deposit id: one card job queued and one active per deposit. */
export const telegramDepositCardPayloadSchema = z.object({ depositId: z.uuid() });

export type TelegramDepositCardPayload = z.infer<typeof telegramDepositCardPayloadSchema>;

/**
 * A plain queue: one run at a time per supplier is the partial unique index on running runs, so a
 * job that finds another run running ends at once (rule SY1). The panel's "sync now" creates its
 * run first and names it, so the panel can follow it; a job without a run creates its own.
 */
export const suppliersSyncPayloadSchema = z.object({
  supplierId: z.uuid(),
  supplierCode: supplierCodeSchema,
  trigger: syncRunTriggerSchema,
  runId: z.uuid().optional(),
});

export type SuppliersSyncPayload = z.infer<typeof suppliersSyncPayloadSchema>;
