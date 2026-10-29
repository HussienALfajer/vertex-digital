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
import { levelTierSchema, merchantTierSchema, tierChangeSourceSchema } from './merchant-tiers.js';
import { currencySchema } from './money.js';
import { adminOrderPurposeSchema } from './orders.js';
import {
  RECONCILIATION_ALERT_MAX_LINES,
  reconciliationCheckSchema,
  reconciliationResultStatusSchema,
  reconciliationRunStatusSchema,
  reconciliationRunTriggerSchema,
  reconciliationSkipReasonSchema,
} from './reconciliation.js';
import {
  STORE_SWITCHES,
  type StoreSwitch,
  storeSwitchSchema,
  switchChannelSchema,
} from './settings.js';
import { supplierCodeSchema, supplierHealthStateSchema } from './suppliers.js';
import { orderProblemSchema, ticketCategorySchema } from './support.js';
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

/** S16 SF2: offers named in one `supplier_stock_low` message; the rest are counted. */
export const TELEGRAM_STOCK_LOW_MAX_LINES = 10;

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
  /** S12 TK8: a customer opened a ticket, or wrote in one (one per ticket per 10 minutes). */
  'ticket_opened',
  'ticket_reply',
  /** S13 NT1: a reconciliation run failed or found a new problem (one per run). */
  'reconciliation_alert',
  /** S16 AP13: every order placed from the panel, so a stolen session shows at once. */
  'admin_order_placed',
  /** S16 SF2: mapped offers whose stock fell to low or out in a sync run (one per run). */
  'supplier_stock_low',
  /** S18 CH2: a supplier charged an attempt more than 2% off its expected cost (one per attempt). */
  'supplier_charge_mismatch',
  /** S19 FC9: the plan expires within 48 hours (once per expiry), turned inactive, or came back. */
  'supplier_subscription',
  /** S20 RP5: a fixed price fell back to its rule (once per list, product and Damascus day). */
  'fixed_price_fallback',
  /** S20: a merchant application submitted or resubmitted, waiting for review. */
  'merchant_application',
  /** S23 TR8: a merchant's effective tier went into or out of Gold or Diamond. */
  'merchant_tier_changed',
  /** S23 MG5: a manual tier grant ends within 3 days (once per grant). */
  'merchant_tier_grant_ending',
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
      'frozen',
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
    /** S07 (audit A05-13): suppliers in use whose recent syncs failed, with the streak's length. */
    syncsFailing: z
      .array(z.object({ supplierNameAr: z.string(), failedRuns: z.int().positive() }))
      .default([]),
    /** S19 FC9 (audit A05-13): suppliers in use whose plan is inactive now. */
    plansInactive: z.array(z.string()).default([]),
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
    /** S09: today's player checks per supplier (rule PV5's count), suppliers with none left out. */
    validations: z
      .array(z.object({ supplierNameAr: z.string(), count: z.int().positive() }))
      .default([]),
    /** S09: real customers' reservations paid (A02) and expired (A15) today. */
    reservationsPaid: z.int().nonnegative().default(0),
    reservationsExpired: z.int().nonnegative().default(0),
    /** S10: real customers' checkouts paid today, and their orders. */
    checkouts: z.int().nonnegative().default(0),
    checkoutOrders: z.int().nonnegative().default(0),
    /** S12 TK13: tickets opened today, and tickets waiting for the admin now. */
    ticketsOpened: z.int().nonnegative().default(0),
    ticketsWaiting: z.int().nonnegative().default(0),
    /** S13 NT2: the newest nightly reconciliation, and the mismatches open now (null: none yet). */
    reconciliation: z
      .object({
        date: z.iso.date(),
        status: reconciliationRunStatusSchema,
        mismatches: z.int().nonnegative(),
        open: z.int().nonnegative(),
      })
      .nullable()
      .default(null),
    /** S16 SC11: offers counted new in imported categories, per supplier with any. */
    newPacks: z
      .array(z.object({ supplierNameAr: z.string(), count: z.int().positive() }))
      .default([]),
    /** S16 SF2: mapped offers of active products low or out of stock now. */
    stockLow: z
      .object({ low: z.int().nonnegative(), out: z.int().nonnegative() })
      .default({ low: 0, out: 0 }),
    /** S16: owner-funded admin orders paid today (net of refunds) against the owner cap. */
    ownerOrders: z
      .object({
        count: z.int().nonnegative(),
        usedUsdUnits: z.int(),
        capUsdUnits: z.int().nonnegative(),
      })
      .nullable()
      .default(null),
    /** S20 RP5: list prices falling back from a fixed price to its rule now. */
    fixedPriceFallbacks: z.int().nonnegative().default(0),
    /** S20: merchant applications waiting for review now. */
    merchantApplicationsWaiting: z.int().nonnegative().default(0),
    /** S21 LV4, S23 AD6: merchants whose effective tier changed today. */
    merchantLevelsChanged: z.int().nonnegative().default(0),
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
  /** S19 FC9. */
  supplier_subscription: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    reason: z.enum(['expiring', 'inactive', 'active']),
    plan: z.string(),
    expiresAt: z.iso.datetime().nullable(),
  }),
  /** S20 RP5: the list, the pack, the cost, the fixed price and the price used instead. */
  fixed_price_fallback: z.object({
    priceListId: z.uuid(),
    priceListName: z.string(),
    productId: z.uuid(),
    productNameAr: z.string(),
    gameNameAr: z.string(),
    costUsdUnits: z.int().positive(),
    fixedPriceUsdUnits: z.int().positive(),
    priceUsdUnits: z.int().positive(),
  }),
  /**
   * S20 (Jobs): no personal data, only the application for the panel link, whether it was a
   * resubmission and how many wait.
   */
  merchant_application: z.object({
    applicationId: z.uuid(),
    resubmitted: z.boolean(),
    waiting: z.int().positive(),
  }),
  /** S23 TR8: the trade name, the tiers, the cause and the months' net purchases. */
  merchant_tier_changed: z.object({
    customerId: z.uuid(),
    tradeName: z.string(),
    from: merchantTierSchema,
    to: merchantTierSchema,
    source: tierChangeSourceSchema,
    thisMonthUsdUnits: z.int(),
    previousMonthUsdUnits: z.int(),
  }),
  /** S23 MG5: the grant's tier and end, and the tier the merchant returns to. */
  merchant_tier_grant_ending: z.object({
    customerId: z.uuid(),
    tradeName: z.string(),
    tier: levelTierSchema,
    endsAt: z.iso.datetime(),
    earnedTier: merchantTierSchema,
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
  /**
   * S18 CH2, CH3: what the supplier charged for an attempt against its expected cost; `loss` when
   * the charged unit cost is above the order's unit price (the offer took the charged cost).
   */
  supplier_charge_mismatch: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    supplierNameAr: z.string(),
    expectedUsdUnits: z.int().nonnegative(),
    chargedUsdUnits: z.int().nonnegative(),
    loss: z.boolean(),
  }),
  /** S09 rule PV5: the first validation refused by a supplier's daily quota, once a day. */
  validation_quota_reached: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    quota: z.int().nonnegative(),
  }),
  /**
   * S12 TK8: the number, the type, the subject (cut to 120), whether there are images and the
   * customer's email; never the message or the images. The link opens the ticket in the panel.
   */
  ticket_opened: z.object({
    ticketId: z.uuid(),
    number: z.string(),
    category: ticketCategorySchema,
    subject: z.string().max(120),
    hasImages: z.boolean(),
    customerEmail: z.string(),
    /** S22 OP6: the problem named at opening. */
    orderProblem: orderProblemSchema.optional(),
  }),
  ticket_reply: z.object({
    ticketId: z.uuid(),
    number: z.string(),
    category: ticketCategorySchema,
    subject: z.string().max(120),
    hasImages: z.boolean(),
    customerEmail: z.string(),
  }),
  /**
   * S13 NT1: the run's Damascus date, "urgent" when an internal check failed, the results that
   * made it alert (at most 10, the rest counted) and the mismatches open now. No customer data.
   */
  reconciliation_alert: z.object({
    runId: z.uuid(),
    trigger: reconciliationRunTriggerSchema,
    date: z.iso.date(),
    failed: z.boolean(),
    urgent: z.boolean(),
    lines: z
      .array(
        z.object({
          check: reconciliationCheckSchema,
          subject: z.string(),
          status: reconciliationResultStatusSchema,
          currency: currencySchema.nullable(),
          differenceUnits: z.int().nullable(),
          offendingCount: z.int().nonnegative(),
          reason: reconciliationSkipReasonSchema.nullable(),
        }),
      )
      .max(RECONCILIATION_ALERT_MAX_LINES),
    moreLines: z.int().nonnegative(),
    open: z.int().nonnegative(),
  }),
  /**
   * S16 AP13: the order number, mode, pack, quantity and total; for an owner-funded order, today's
   * owner total against the cap. Never field values or codes.
   */
  admin_order_placed: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    purpose: adminOrderPurposeSchema,
    gameNameAr: z.string(),
    productNameAr: z.string(),
    quantity: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    owner: z.object({ usedUsdUnits: z.int(), capUsdUnits: z.int().nonnegative() }).nullable(),
  }),
  /** S16 SF2: up to 10 offers named, then a count; never field values. */
  supplier_stock_low: z.object({
    supplier: supplierCodeSchema,
    supplierNameAr: z.string(),
    runId: z.uuid(),
    offers: z
      .array(
        z.object({
          gameNameAr: z.string(),
          productNameAr: z.string(),
          level: z.enum(['low', 'out']),
          stock: z.int().nonnegative().nullable(),
        }),
      )
      .min(1)
      .max(TELEGRAM_STOCK_LOW_MAX_LINES),
    more: z.int().nonnegative(),
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
export type TelegramApprovalRefusal = 'panel_only' | 'frozen' | 'off' | 'flagged' | 'over_limit';

export function telegramApprovalRefusal(input: {
  method: DepositMethod;
  /** S12 CF4: a frozen customer's deposit is approved in the panel only ("العميل مجمّد"). */
  customerFrozen: boolean;
  flagCount: number;
  creditUsdUnits: number;
  /** `deposit_settings.telegram_approval_max_usd_units`; 0 turns approval off. */
  limitUsdUnits: number;
}): TelegramApprovalRefusal | null {
  if (input.method !== 'sham_cash') return 'panel_only';
  if (input.customerFrozen) return 'frozen';
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
