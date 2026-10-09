import { z } from 'zod';
import {
  approveDepositSchema,
  DEPOSIT_REJECT_REASONS,
  type DepositMethod,
  type DepositRejectReason,
  depositMethodSchema,
  depositRejectReasonSchema,
  isWithinReviewHours,
  nextReviewOpening,
  type ReviewHours,
  rejectDepositSchema,
} from './deposits.js';
import { currencySchema } from './money.js';
import {
  STORE_SWITCHES,
  type StoreSwitch,
  storeSwitchSchema,
  switchChannelSchema,
} from './settings.js';
import { supplierCodeSchema, supplierHealthStateSchema } from './suppliers.js';
import { usdtMethodSchema } from './usdt.js';

/*
 * The Telegram admin bot (S05 F07, rules TG1–TG7, ADR 0019), owned by the api `telegram` module.
 * Telegram posts updates to the API's webhook; the API answers a button press inline and queues
 * every other message as a `telegram_messages` row (the outbox), which the worker sends.
 */

/** How long a link code (rule TG3) and a bot question (rule TG7) stay valid. */
export const TELEGRAM_LINK_CODE_TTL_SECONDS = 10 * 60;
export const TELEGRAM_PROMPT_TTL_SECONDS = 10 * 60;

/** A link code: 128 random bits in base64url, returned once and stored as its SHA-256 (TG3). */
export const telegramLinkCodeValueSchema = z.string().regex(/^[\w-]{22}$/);

/** What an emergency stop from Telegram turns on (rule AL4); turning it off is panel-only. */
export const STOP_SCOPES = ['purchases', 'deposits', 'both'] as const;

export const stopScopeSchema = z.enum(STOP_SCOPES);

export type StopScope = z.infer<typeof stopScopeSchema>;

export const STOP_SCOPE_SWITCHES: Record<StopScope, readonly StoreSwitch[]> = {
  purchases: ['purchases_stopped'],
  deposits: ['deposits_stopped'],
  both: ['purchases_stopped', 'deposits_stopped'],
};

/** Every switch's value, as a `/status` reply carries them. */
const switchValuesSchema = z.object(
  Object.fromEntries(STORE_SWITCHES.map((name) => [name, z.boolean()])) as Record<
    StoreSwitch,
    z.ZodBoolean
  >,
);

/** The reminder lists at most this many deposits, then "و N غيرها" (rule RM3). */
export const TELEGRAM_REMINDER_MAX_LINES = 10;

/*
 * The outbox (`telegram_messages`): a kind and its parameters, rendered in Arabic by the worker.
 * Parameters hold what the message says and nothing more: no tokens, receipts or notes.
 */

export const TELEGRAM_MESSAGE_KINDS = [
  'switch_changed',
  'usdt_unmatched',
  'review_reminder',
  'daily_summary',
  'bot_reply',
  'link_changed',
  'test',
  'supplier_sync_summary',
  'supplier_health',
  'supplier_balance_low',
  'supplier_sync_failing',
  'manual_order',
  'manual_order_reminder',
  'order_needs_review',
  'order_conflict',
  'validation_quota_reached',
] as const;

export const telegramMessageKindSchema = z
  .enum(TELEGRAM_MESSAGE_KINDS)
  .meta({ id: 'TelegramMessageKind' });

export type TelegramMessageKind = z.infer<typeof telegramMessageKindSchema>;

/** `skipped`: nobody to send it to (no live link) or the bot is not configured (edge case 2). */
export const TELEGRAM_MESSAGE_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;

export const telegramMessageStatusSchema = z
  .enum(TELEGRAM_MESSAGE_STATUSES)
  .meta({ id: 'TelegramMessageStatus' });

export type TelegramMessageStatus = z.infer<typeof telegramMessageStatusSchema>;

/** The bot's answers to the admin (rules TG3, TG5, TG7, AL4). */
export const telegramBotReplySchema = z.discriminatedUnion('reply', [
  z.object({
    reply: z.enum([
      /** The chat was just linked: what the bot does, `/status` and `/stop`. */
      'welcome',
      /** The commands; also the answer to text with no open question. */
      'help',
      /** `/start` with a wrong, used or expired code: one generic text. */
      'invalid_code',
      /** `/stop`: the three stop buttons. */
      'stop_choose',
      /** Every switch of the chosen stop is already on. */
      'stop_already',
      /** An action failed after the update was accepted (rule TG5). */
      'failed',
    ]),
  }),
  z.object({
    reply: z.literal('status'),
    switches: switchValuesSchema,
    /** Sham Cash deposits submitted and USDT deposits in review. */
    waiting: z.int().nonnegative(),
    unmatchedTransfers: z.int().nonnegative(),
  }),
  /** The confirmation of a stop, with "تأكيد" and "إلغاء" for its prompt. */
  z.object({ reply: z.literal('stop_confirm'), promptId: z.uuid(), scope: stopScopeSchema }),
  /** Rule TC4 step 1: asks for the Sham Cash transaction number. */
  z.object({ reply: z.literal('approve_number'), referenceCode: z.string() }),
  /** Rule TC4 step 2: the approval to confirm, with "تأكيد" and "إلغاء". */
  z.object({
    reply: z.literal('approve_confirm'),
    promptId: z.uuid(),
    referenceCode: z.string(),
    creditedUsdUnits: z.int().positive(),
    transactionNumber: z.string(),
  }),
  /** Rule TC5: the reason buttons of a rejection. */
  z.object({
    reply: z.literal('reject_reasons'),
    promptId: z.uuid(),
    referenceCode: z.string(),
    reasons: z.array(depositRejectReasonSchema).min(1),
  }),
  /** Rule TC5: asks for the internal note of a rejection. */
  z.object({
    reply: z.literal('reject_note'),
    referenceCode: z.string(),
    reason: depositRejectReasonSchema,
  }),
  /** The answer to a prompt was not valid; the prompt stays open. */
  z.object({ reply: z.literal('invalid_answer'), field: z.enum(['transaction_number', 'note']) }),
  /** Rule TC4 step 4: credited. */
  z.object({
    reply: z.literal('approved'),
    referenceCode: z.string(),
    creditedUsdUnits: z.int().positive(),
  }),
  /** Rule TC5: rejected. */
  z.object({
    reply: z.literal('rejected'),
    referenceCode: z.string(),
    reason: depositRejectReasonSchema,
  }),
  /** A decision the service refused (rule TC4 step 4, edge cases 3–5). */
  z.object({
    reply: z.literal('decision_refused'),
    referenceCode: z.string(),
    refusal: z.enum([
      'decided',
      'reference_taken',
      'changed',
      'flagged',
      'over_limit',
      'off',
      'panel_only',
    ]),
  }),
]);

export type TelegramBotReply = z.infer<typeof telegramBotReplySchema>;

export const TELEGRAM_MESSAGE_PARAMS = {
  /** Rule AL2: every switch change, from the panel or from Telegram. */
  switch_changed: z.object({
    switch: storeSwitchSchema,
    value: z.boolean(),
    channel: switchChannelSchema,
  }),
  /** Rule TC7: a USDT transfer no deposit matched; the sender's address shortened. */
  usdt_unmatched: z.object({
    transferId: z.uuid(),
    method: usdtMethodSchema,
    amountUnits: z.int().positive(),
    sender: z.string().max(32),
    candidates: z.int().nonnegative(),
  }),
  /** Rule RM3: the overdue reviews, oldest first, at most 10 listed. */
  review_reminder: z.object({
    count: z.int().positive(),
    oldestWaitMinutes: z.int().nonnegative(),
    deposits: z
      .array(z.object({ referenceCode: z.string(), waitMinutes: z.int().nonnegative() }))
      .min(1)
      .max(TELEGRAM_REMINDER_MAX_LINES),
  }),
  /** Rule AL3: the Damascus calendar day so far. */
  daily_summary: z.object({
    date: z.iso.date(),
    credited: z.array(
      z.object({
        method: depositMethodSchema,
        count: z.int().positive(),
        usdUnits: z.int().nonnegative(),
      }),
    ),
    approvedFromTelegram: z.int().nonnegative(),
    rejected: z.int().nonnegative(),
    expired: z.int().nonnegative(),
    waiting: z.int().nonnegative(),
    oldestWaitMinutes: z.int().nonnegative().nullable(),
    unmatchedToday: z.int().nonnegative(),
    unmatchedOpen: z.int().nonnegative(),
    newCustomers: z.int().nonnegative(),
    /** Real customers' wallets (S02 rule L1). */
    walletsTotalUsdUnits: z.int(),
    registrationOpen: z.boolean(),
    /** Every stop and pause that is on, with since when. */
    activeSwitches: z.array(z.object({ switch: storeSwitchSchema, since: z.iso.datetime() })),
    /** Alerts the rate limit held back today, in this worker. */
    suppressedAlerts: z.int().nonnegative(),
    /** S07: price changes waiting in the review queue. */
    openReviews: z.int().nonnegative().default(0),
    /** S07: products the margin guard holds (rule P6). */
    marginGuarded: z.int().nonnegative().default(0),
    /** S07: suppliers in use that are not `healthy`. */
    suppliersNotHealthy: z
      .array(z.object({ supplierNameAr: z.string(), state: supplierHealthStateSchema }))
      .default([]),
    /** S07: suppliers whose newest balance is below their threshold (rule H5). */
    balancesLow: z
      .array(
        z.object({ supplierNameAr: z.string(), currency: currencySchema, amountUnits: z.int() }),
      )
      .default([]),
    /** S08: orders of real customers that ended today, by how they ended. */
    ordersDelivered: z.int().nonnegative().default(0),
    ordersPartiallyRefunded: z.int().nonnegative().default(0),
    ordersRefunded: z.int().nonnegative().default(0),
    /** S08: orders in `needs_review` and open manual attempts, now. */
    ordersInReview: z.int().nonnegative().default(0),
    manualWaiting: z.int().nonnegative().default(0),
    /** S08: the median of today's delivery times of real customers' orders (null with none). */
    medianDeliveryMs: z.int().nonnegative().nullable().default(null),
  }),
  bot_reply: telegramBotReplySchema,
  /** To the previous chat when another chat was linked (rule TG3). */
  link_changed: z.object({}),
  /** The panel's "إرسال رسالة اختبار". */
  test: z.object({}),
  /** S07: a sync run that opened reviews, guarded products or lost mapped offers. */
  supplier_sync_summary: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    runId: z.uuid(),
    reviewsOpened: z.int().nonnegative(),
    marginGuarded: z.int().nonnegative(),
    mappedMissing: z.int().nonnegative(),
  }),
  /** S07 rule H4: a health change. */
  supplier_health: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    state: supplierHealthStateSchema,
    previous: supplierHealthStateSchema,
    successBp: z.int().min(0).max(10_000).nullable(),
  }),
  /** S07 rule H5: a balance below its threshold (and its repeats), or back at or above it. */
  supplier_balance_low: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    currency: currencySchema,
    amountUnits: z.int(),
    thresholdUsdUnits: z.int().nonnegative(),
    recovered: z.boolean(),
  }),
  /** S07: syncs failing in a row, then once when costs go stale and products become unavailable. */
  supplier_sync_failing: z.discriminatedUnion('reason', [
    z.object({
      reason: z.literal('runs_failed'),
      supplier: supplierCodeSchema,
      supplierNameAr: z.string(),
      failedRuns: z.int().positive(),
      errorCode: z.string().nullable(),
    }),
    z.object({
      reason: z.literal('costs_stale'),
      supplier: supplierCodeSchema,
      supplierNameAr: z.string(),
      unavailableProducts: z.int().nonnegative(),
    }),
  ]),
  /**
   * S08 rule MN1: a manual attempt waits for the admin. Never field values or codes; the link
   * opens the order in the panel.
   */
  manual_order: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    gameNameAr: z.string(),
    productNameAr: z.string(),
    quantity: z.int().positive(),
    sentAt: z.iso.datetime(),
  }),
  /** S08 rule MN2: the one reminder of a manual attempt still open. */
  manual_order_reminder: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    gameNameAr: z.string(),
    productNameAr: z.string(),
    quantity: z.int().positive(),
    waitMinutes: z.int().nonnegative(),
  }),
  /** S08 rule F7: an automatic attempt past the hard limit; the order is held for the admin. */
  order_needs_review: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    supplierNameAr: z.string(),
    waitMinutes: z.int().nonnegative(),
  }),
  /**
   * S08 rule F5: a webhook reported another result for a closed attempt (delivered after failed,
   * or failed after delivered): a possible double delivery, for the admin and reconciliation.
   */
  order_conflict: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    supplierNameAr: z.string(),
    attemptStatus: z.enum(['delivered', 'failed']),
    reported: z.enum(['delivered', 'failed']),
  }),
  /** S09 rule PV5: the first validation refused by a supplier's daily quota, once a day. */
  validation_quota_reached: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    quota: z.int().nonnegative(),
  }),
} as const satisfies Record<TelegramMessageKind, z.ZodType>;

export type TelegramMessageParams<Kind extends TelegramMessageKind> = z.infer<
  (typeof TELEGRAM_MESSAGE_PARAMS)[Kind]
>;

/*
 * Bot questions (`telegram_prompts`, rule TG7): at most one open; opening one closes the others.
 */

export const TELEGRAM_PROMPT_KINDS = [
  'approve_number',
  'approve_confirm',
  'reject_note',
  'stop_confirm',
] as const;

export type TelegramPromptKind = (typeof TELEGRAM_PROMPT_KINDS)[number];

/** Rule TC4: the transaction number, normalized as the panel's approval (S03 rule RV1). */
export const telegramTransactionNumberSchema = approveDepositSchema.shape.transactionNumber;

/** Rule TC5: the internal note of a rejection from Telegram, as the panel's. */
export const telegramRejectNoteSchema = rejectDepositSchema.shape.internalNote;

/**
 * The deposit prompts name their deposit and the submission they were opened on
 * (`telegram_prompts.deposit_id`, `deposit_submitted_at`); a resubmission refuses them (edge case 4).
 */
export const TELEGRAM_PROMPT_DATA = {
  approve_number: z.object({}),
  approve_confirm: z.object({ transactionNumber: telegramTransactionNumberSchema }),
  /** `reason` is null until a reason button is pressed. */
  reject_note: z.object({ reason: depositRejectReasonSchema.nullable() }),
  stop_confirm: z.object({ scope: stopScopeSchema }),
} as const satisfies Record<TelegramPromptKind, z.ZodType>;

/**
 * Rule TC5: the reasons a rejection from Telegram offers. `other` needs a customer note, which is
 * panel-only; the USDT reasons only for a USDT review (S04 rule U16).
 */
export function telegramRejectReasons(method: DepositMethod): DepositRejectReason[] {
  const usdtOnly = new Set<DepositRejectReason>(['wrong_network', 'transfer_other_customer']);
  return DEPOSIT_REJECT_REASONS.filter(
    (reason) => reason !== 'other' && (method !== 'sham_cash' || !usdtOnly.has(reason)),
  );
}

/** Why a deposit cannot be approved from Telegram (rule TC4), or null when it can. */
export type TelegramApprovalRefusal = 'panel_only' | 'off' | 'flagged' | 'over_limit';

export function telegramApprovalRefusal(input: {
  method: DepositMethod;
  flagCount: number;
  creditUsdUnits: number;
  /** `deposit_settings.telegram_approval_max_usd_units`; 0 turns approval off. */
  limitUsdUnits: number;
}): TelegramApprovalRefusal | null {
  if (input.method !== 'sham_cash') return 'panel_only';
  if (input.limitUsdUnits === 0) return 'off';
  if (input.flagCount > 0) return 'flagged';
  return input.creditUsdUnits > input.limitUsdUnits ? 'over_limit' : null;
}

/*
 * Button data (rule TG6): `<prefix>:<value>`, at most 64 bytes as Telegram allows.
 */

export const TELEGRAM_CALLBACKS = {
  stop: 'st',
  confirm: 'ok',
  cancel: 'no',
  approve: 'ap',
  reject: 'rj',
  reason: 'rr',
} as const;

export type TelegramCallback =
  | { action: 'stop'; scope: StopScope }
  | { action: 'confirm' | 'cancel'; promptId: string }
  | { action: 'approve' | 'reject'; depositId: string }
  | { action: 'reason'; promptId: string; reason: DepositRejectReason };

/** A `Map`, so an inherited key (`constructor`) is never a prefix. */
const callbackActions = new Map(
  Object.entries(TELEGRAM_CALLBACKS).map(([action, prefix]) => [prefix, action]),
) as Map<string, TelegramCallback['action']>;

function callbackValue(callback: TelegramCallback): string {
  switch (callback.action) {
    case 'stop':
      return callback.scope;
    case 'approve':
    case 'reject':
      return callback.depositId;
    case 'reason':
      return `${callback.promptId}:${callback.reason}`;
    default:
      return callback.promptId;
  }
}

export function telegramCallbackData(callback: TelegramCallback): string {
  return `${TELEGRAM_CALLBACKS[callback.action]}:${callbackValue(callback)}`;
}

/** The button pressed, or null for data this bot never sent. */
export function parseTelegramCallback(data: string): TelegramCallback | null {
  const separator = data.indexOf(':');
  const action = callbackActions.get(data.slice(0, separator));
  const value = data.slice(separator + 1);
  if (separator < 0 || !action) return null;
  const isUuid = (text: string) => z.uuid().safeParse(text).success;
  switch (action) {
    case 'stop': {
      const scope = stopScopeSchema.safeParse(value);
      return scope.success ? { action, scope: scope.data } : null;
    }
    case 'approve':
    case 'reject':
      return isUuid(value) ? { action, depositId: value } : null;
    case 'reason': {
      const [promptId = '', reason, ...rest] = value.split(':');
      const parsed = depositRejectReasonSchema.exclude(['other']).safeParse(reason);
      return isUuid(promptId) && parsed.success && rest.length === 0
        ? { action, promptId, reason: parsed.data }
        : null;
    }
    default:
      return isUuid(value) ? { action, promptId: value } : null;
  }
}

/*
 * The review reminder (rules RM1–RM4).
 */

/** After the first reminder, overdue reviews are repeated every 30 minutes (rule RM3). */
export const TELEGRAM_REMINDER_REPEAT_MINUTES = 30;

/**
 * Rule RM2: a waiting deposit's wait counts from its submission, or from the next opening of the
 * review hours when it was submitted outside them.
 */
export function reviewWaitStart(submittedAt: Date, hours: ReviewHours): Date {
  return isWithinReviewHours(submittedAt, hours)
    ? submittedAt
    : nextReviewOpening(submittedAt, hours);
}

export interface WaitingReview {
  submittedAt: Date;
  /** When a reminder listed it (its card's `reminded_at`); null when never, or with no card. */
  remindedAt: Date | null;
}

/**
 * The overdue reviews at `now` (rule RM2), oldest first, each with its wait in whole minutes and
 * the instant it became overdue.
 */
export function overdueReviews<Review extends WaitingReview>(
  reviews: readonly Review[],
  now: Date,
  hours: ReviewHours,
  targetMinutes: number,
): (Review & { waitMinutes: number; overdueAt: Date })[] {
  return reviews
    .map((review) => {
      const start = reviewWaitStart(review.submittedAt, hours).getTime();
      return {
        ...review,
        waitMinutes: Math.max(0, Math.floor((now.getTime() - start) / 60_000)),
        overdueAt: new Date(start + targetMinutes * 60_000),
      };
    })
    .filter((review) => review.overdueAt <= now)
    .sort((a, b) => b.waitMinutes - a.waitMinutes);
}

/**
 * Rule RM3, within the review hours only (RM1): a reminder is due when an overdue review was never
 * listed (it became overdue after the last reminder and its card has no `reminded_at`), or when
 * overdue reviews remain and the last reminder is 30 minutes old or more.
 */
export function reviewReminderDue(input: {
  now: Date;
  hours: ReviewHours;
  lastReminderAt: Date | null;
  overdue: readonly (WaitingReview & { overdueAt: Date })[];
}): boolean {
  const { now, lastReminderAt, overdue } = input;
  if (!isWithinReviewHours(now, input.hours) || overdue.length === 0) return false;
  if (!lastReminderAt) return true;
  const unlisted = overdue.some(
    (review) => review.remindedAt === null && review.overdueAt > lastReminderAt,
  );
  const repeat =
    now.getTime() - lastReminderAt.getTime() >= TELEGRAM_REMINDER_REPEAT_MINUTES * 60_000;
  return unlisted || repeat;
}

/*
 * The webhook (`POST /api/webhooks/telegram`): the part of Telegram's `Update` the bot reads.
 * Unknown fields are dropped; an update without a message or a button press is ignored.
 */

const telegramUserSchema = z.object({
  id: z.int(),
  username: z.string().max(64).optional(),
});

const telegramChatSchema = z.object({ id: z.int(), type: z.string().max(32) });

export const telegramUpdateSchema = z
  .object({
    update_id: z.int().nonnegative(),
    message: z
      .object({
        message_id: z.int(),
        from: telegramUserSchema.optional(),
        chat: telegramChatSchema,
        text: z.string().max(4096).optional(),
      })
      .optional(),
    callback_query: z
      .object({
        id: z.string().max(64),
        from: telegramUserSchema,
        message: z.object({ message_id: z.int(), chat: telegramChatSchema }).optional(),
        data: z.string().max(64).optional(),
      })
      .optional(),
  })
  .meta({ id: 'TelegramUpdate' });

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

/*
 * The panel's Telegram page (`/settings/telegram`).
 */

/** `GET /api/admin/telegram`. */
export const telegramLinkStatusSchema = z
  .object({
    /** The bot's username and webhook secret are set on the server (rule TG1). */
    configured: z.boolean(),
    /** The live link (rule TG3); null when no chat is linked. */
    link: z
      .object({
        /** The Telegram username at linking time, shown in the panel only. */
        username: z.string().nullable(),
        since: z.iso.datetime(),
      })
      .nullable(),
    /** The newest outbox message, so a blocked bot shows its error (edge case 19). */
    lastMessage: z
      .object({
        kind: telegramMessageKindSchema,
        status: telegramMessageStatusSchema,
        createdAt: z.iso.datetime(),
        sentAt: z.iso.datetime().nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'TelegramLinkStatus' });

export type TelegramLinkStatus = z.infer<typeof telegramLinkStatusSchema>;

/** `POST /api/admin/telegram/link-code`: shown once, never stored (rule TG3). */
export const telegramLinkCodeSchema = z
  .object({ deepLink: z.url(), expiresAt: z.iso.datetime() })
  .meta({ id: 'TelegramLinkCode' });

export type TelegramLinkCode = z.infer<typeof telegramLinkCodeSchema>;
