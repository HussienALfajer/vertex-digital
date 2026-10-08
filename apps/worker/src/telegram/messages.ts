import {
  type DepositFlagCode,
  type DepositMethod,
  type DepositRejectReason,
  formatSyp,
  formatUsd,
  formatUsdtAmount,
  type StopScope,
  type StoreSwitch,
  type SupplierHealthState,
  type SwitchChannel,
  type TelegramApprovalRefusal,
  type TelegramBotReply,
  type TelegramMessageKind,
  type TelegramMessageParams,
  telegramCallbackData,
  USDT_NETWORKS,
} from '@vertex-digital/contracts';

export interface TelegramButton {
  text: string;
  /** Callback data (rule TG6). */
  data: string;
}

export interface RenderedTelegramMessage {
  text: string;
  /** Rows of inline buttons. */
  buttons?: TelegramButton[][];
}

const CHANNELS: Record<SwitchChannel, string> = { admin: 'اللوحة', telegram: 'تيليجرام' };

/** Each switch's notice when turned on and off (rule AL2). */
const SWITCH_NOTICES: Record<StoreSwitch, { on: string; off: string }> = {
  registration_open: { on: '🟢 التسجيل مفتوح الآن', off: '🔒 التسجيل مغلق الآن' },
  purchases_stopped: { on: '⛔ أُوقف الشراء', off: '✅ أُعيد فتح الشراء' },
  deposits_stopped: { on: '⛔ أُوقفت الإيداعات', off: '✅ أُعيد فتح الإيداعات' },
  sham_cash_paused: { on: '⏸ أُوقف إيداع شام كاش مؤقتاً', off: '▶️ أُعيد فتح إيداع شام كاش' },
  usdt_trc20_paused: { on: '⏸ أُوقف إيداع USDT TRC20 مؤقتاً', off: '▶️ أُعيد فتح إيداع USDT TRC20' },
  usdt_bep20_paused: { on: '⏸ أُوقف إيداع USDT BEP20 مؤقتاً', off: '▶️ أُعيد فتح إيداع USDT BEP20' },
  shop2topup_paused: { on: '⏸ أُوقف المورد SHOP2TOPUP مؤقتاً', off: '▶️ استُؤنف المورد SHOP2TOPUP' },
  wdgzone_paused: { on: '⏸ أُوقف المورد WDGZone مؤقتاً', off: '▶️ استُؤنف المورد WDGZone' },
  manual_paused: { on: '⏸ أُوقف المورد اليدوي مؤقتاً', off: '▶️ استُؤنف المورد اليدوي' },
  fake_paused: { on: '⏸ أُوقف المورد التجريبي مؤقتاً', off: '▶️ استُؤنف المورد التجريبي' },
};

const SCOPES: Record<StopScope, string> = {
  purchases: 'الشراء',
  deposits: 'الإيداعات',
  both: 'الشراء والإيداعات',
};

const REOPEN = 'إعادة الفتح من اللوحة فقط.';

const METHODS: Record<DepositMethod, string> = {
  sham_cash: 'شام كاش',
  usdt_trc20: 'USDT TRC20',
  usdt_bep20: 'USDT BEP20',
};

/** The panel's words for each reason (S03 rule RV6, S04 rule U16). */
const REJECT_REASONS: Record<DepositRejectReason, string> = {
  not_received: 'لم يصل التحويل',
  receipt_invalid: 'الإيصال غير صالح أو معدَّل',
  receipt_used: 'الإيصال مستخدم سابقاً',
  reference_other_customer: 'رمز المرجع يخص حساباً آخر',
  wrong_account: 'التحويل إلى حساب آخر',
  wrong_network: 'شبكة غير الشبكة المختارة',
  transfer_other_customer: 'التحويل يخص طلباً آخر',
  other: 'سبب آخر',
};

/** The panel's flag labels (A10). */
const FLAGS: Record<DepositFlagCode, string> = {
  receipt_reused: 'إيصال مكرّر',
  receipt_similar: 'إيصال مشابه',
  new_account_large: 'مبلغ كبير لحساب جديد',
  velocity: 'إيداعات متلاحقة',
  shared_phone: 'رقم هاتف مشترك',
  amount_mismatch: 'مبلغ مختلف',
  reference_missing: 'رمز المرجع مفقود',
  reference_different: 'رمز مرجع مختلف',
  wrong_network: 'شبكة مختلفة',
  sent_before_deposit: 'تحويل أقدم من الإيداع',
};

/** Why a card has no "اعتماد" (rule TC2). */
const APPROVAL_REFUSALS: Record<TelegramApprovalRefusal, string> = {
  panel_only: 'الاعتماد من اللوحة فقط',
  off: 'الاعتماد من تيليجرام متوقف',
  flagged: 'عليه علامات، الاعتماد من اللوحة',
  over_limit: 'فوق حد تيليجرام، الاعتماد من اللوحة',
};

/** The answers to a refused decision (rule TC4 step 4, edge cases 3–5). */
const DECISION_REFUSALS: Record<
  Extract<TelegramBotReply, { reply: 'decision_refused' }>['refusal'],
  string
> = {
  decided: 'تم البت فيه مسبقاً.',
  reference_taken: 'رقم العملية مستخدم سابقاً، راجع من اللوحة.',
  changed: 'تغيّر الإيداع، استخدم البطاقة الجديدة.',
  flagged: 'عليه علامات، اعتمد من اللوحة.',
  over_limit: 'فوق حد تيليجرام، اعتمد من اللوحة.',
  off: 'الاعتماد من تيليجرام متوقف، اعتمد من اللوحة.',
  panel_only: 'من اللوحة فقط.',
};

/** A wait in words: "12 د" or "3 س 5 د". */
function waitText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} س ${minutes % 60} د` : `${minutes} د`;
}

/** An address or TXID shortened to its ends. */
export const shorten = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;

const confirmButtons = (promptId: string): TelegramButton[][] => [
  [
    { text: 'تأكيد', data: telegramCallbackData({ action: 'confirm', promptId }) },
    { text: 'إلغاء', data: telegramCallbackData({ action: 'cancel', promptId }) },
  ],
];

const COMMANDS = [
  '/status حالة المتجر وما ينتظر المراجعة',
  `/stop إيقاف طارئ للشراء أو الإيداع (${REOPEN.slice(0, -1)})`,
  '/help الأوامر',
].join('\n');

function statusText(reply: Extract<TelegramBotReply, { reply: 'status' }>): string {
  const { switches } = reply;
  const running = (stopped: boolean, word: string) => (stopped ? word : 'يعمل');
  return [
    'حالة المتجر:',
    `التسجيل: ${switches.registration_open ? 'مفتوح' : 'مغلق'}`,
    `الشراء: ${running(switches.purchases_stopped, '⛔ متوقف')}`,
    `الإيداع: ${running(switches.deposits_stopped, '⛔ متوقف')}`,
    `شام كاش: ${running(switches.sham_cash_paused, '⏸ متوقف مؤقتاً')}`,
    `USDT TRC20: ${running(switches.usdt_trc20_paused, '⏸ متوقف مؤقتاً')}`,
    `USDT BEP20: ${running(switches.usdt_bep20_paused, '⏸ متوقف مؤقتاً')}`,
    '',
    `بانتظار المراجعة: ${reply.waiting}`,
    `تحويلات USDT غير مطابقة: ${reply.unmatchedTransfers}`,
  ].join('\n');
}

function botReply(reply: TelegramBotReply): RenderedTelegramMessage {
  switch (reply.reply) {
    case 'welcome':
      return {
        text: `تم ربط هذه المحادثة بلوحة Vertex Digital. ستصلك هنا التنبيهات وتغييرات المفاتيح.\n\n${COMMANDS}`,
      };
    case 'help':
      return { text: `الأوامر:\n${COMMANDS}` };
    case 'invalid_code':
      return { text: 'الرمز غير صالح' };
    case 'stop_choose':
      return {
        text: `ماذا تريد أن توقف؟ ${REOPEN}`,
        buttons: (['purchases', 'deposits', 'both'] as const).map((scope) => [
          { text: SCOPES[scope], data: telegramCallbackData({ action: 'stop', scope }) },
        ]),
      };
    case 'stop_already':
      return { text: `متوقف مسبقاً. ${REOPEN}` };
    case 'stop_confirm':
      return {
        text: `إيقاف ${SCOPES[reply.scope]}؟ ${REOPEN}`,
        buttons: confirmButtons(reply.promptId),
      };
    case 'approve_number':
      return {
        text: `أرسل رقم عملية شام كاش لـ ${reply.referenceCode}. تأكد من وصول التحويل في حساب شام كاش نفسه، لا من الصورة.`,
      };
    case 'approve_confirm':
      return {
        text: `اعتماد ${reply.referenceCode}: إضافة ${formatUsd(reply.creditedUsdUnits)} برقم العملية ${reply.transactionNumber}؟`,
        buttons: confirmButtons(reply.promptId),
      };
    case 'reject_reasons':
      return {
        text: `سبب رفض ${reply.referenceCode}؟ (سبب آخر أو ملاحظة للعميل من اللوحة)`,
        buttons: [
          ...reply.reasons.map((reason) => [
            {
              text: REJECT_REASONS[reason],
              data: telegramCallbackData({ action: 'reason', promptId: reply.promptId, reason }),
            },
          ]),
          [
            {
              text: 'إلغاء',
              data: telegramCallbackData({ action: 'cancel', promptId: reply.promptId }),
            },
          ],
        ],
      };
    case 'reject_note':
      return {
        text: `رفض ${reply.referenceCode}: ${REJECT_REASONS[reply.reason]}. أرسل ملاحظة داخلية (من 5 إلى 500 حرف)، لا يراها العميل.`,
      };
    case 'invalid_answer':
      return {
        text:
          reply.field === 'transaction_number'
            ? 'رقم العملية غير صالح (حتى 64 حرفاً). أرسله من جديد.'
            : 'الملاحظة من 5 إلى 500 حرف. أرسلها من جديد.',
      };
    case 'approved':
      return {
        text: `✅ اعتُمد ${reply.referenceCode}: أُضيف ${formatUsd(reply.creditedUsdUnits)} إلى رصيد العميل.`,
      };
    case 'rejected':
      return { text: `❌ رُفض ${reply.referenceCode}: ${REJECT_REASONS[reply.reason]}.` };
    case 'decision_refused':
      return { text: `${reply.referenceCode}: ${DECISION_REFUSALS[reply.refusal]}` };
    case 'failed':
      return { text: 'تعذّر تنفيذ الطلب. حاول من اللوحة.' };
    case 'status':
      return { text: statusText(reply) };
  }
}

/** Where the messages link to: the panel's origin. */
export interface TelegramLinks {
  admin: string;
}

const SWITCH_NAMES: Record<StoreSwitch, string> = {
  registration_open: 'التسجيل',
  purchases_stopped: 'الشراء متوقف',
  deposits_stopped: 'الإيداع متوقف',
  sham_cash_paused: 'شام كاش متوقف مؤقتاً',
  usdt_trc20_paused: 'USDT TRC20 متوقف مؤقتاً',
  usdt_bep20_paused: 'USDT BEP20 متوقف مؤقتاً',
  shop2topup_paused: 'SHOP2TOPUP متوقف مؤقتاً',
  wdgzone_paused: 'WDGZone متوقف مؤقتاً',
  manual_paused: 'المورد اليدوي متوقف مؤقتاً',
  fake_paused: 'المورد التجريبي متوقف مؤقتاً',
};

const damascusTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Damascus',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A time in Damascus, Latin digits: "08/10 23:05". */
export const atDamascus = (at: Date) => damascusTime.format(at).replace(',', '');

const HEALTH: Record<SupplierHealthState, string> = {
  healthy: 'سليم',
  degraded: 'متراجع',
  down: 'متوقف',
};

/** A supplier's balance in its own currency. */
const balanceText = (currency: 'USD' | 'SYP', units: number) =>
  currency === 'USD' ? formatUsd(units) : formatSyp(units);

const successText = (successBp: number | null) =>
  successBp === null ? '' : `: نجاح ${Math.floor(successBp / 100)}%`;

/** S07: the supplier messages (sync summary, health, balance, failing sync). */
function supplierText<Kind extends TelegramMessageKind>(
  kind: Kind,
  params: TelegramMessageParams<Kind>,
  links: TelegramLinks,
): string {
  switch (kind) {
    case 'supplier_sync_summary': {
      const run = params as TelegramMessageParams<'supplier_sync_summary'>;
      const parts = [
        ...(run.reviewsOpened > 0 ? [`تغييرات أسعار للمراجعة: ${run.reviewsOpened}`] : []),
        ...(run.marginGuarded > 0 ? [`باقات أوقفها حارس الهامش: ${run.marginGuarded}`] : []),
        ...(run.mappedMissing > 0 ? [`عروض مربوطة اختفت: ${run.mappedMissing}`] : []),
      ];
      return [
        `🔄 مزامنة ${run.supplierNameAr}: ${parts.join('، ')}`,
        run.reviewsOpened > 0
          ? `${links.admin}/pricing/reviews`
          : `${links.admin}/suppliers/${run.supplier}`,
      ].join('\n');
    }
    case 'supplier_health': {
      const change = params as TelegramMessageParams<'supplier_health'>;
      const headline =
        change.state === 'healthy'
          ? `✅ ${change.supplierNameAr} عاد سليماً`
          : change.state === 'degraded'
            ? `⚠️ ${change.supplierNameAr} متراجع${successText(change.successBp)}`
            : `⛔ ${change.supplierNameAr} متوقف${successText(change.successBp)}`;
      return [headline, `${links.admin}/suppliers/${change.supplier}`].join('\n');
    }
    case 'supplier_balance_low': {
      const balance = params as TelegramMessageParams<'supplier_balance_low'>;
      const amount = balanceText(balance.currency, balance.amountUnits);
      return [
        balance.recovered
          ? `✅ رصيد ${balance.supplierNameAr} عاد إلى الحد أو فوقه: ${amount}`
          : `💰 رصيد ${balance.supplierNameAr} تحت الحد: ${amount} (الحد ${formatUsd(balance.thresholdUsdUnits)})`,
        `${links.admin}/suppliers/${balance.supplier}`,
      ].join('\n');
    }
    default: {
      const failing = params as TelegramMessageParams<'supplier_sync_failing'>;
      return [
        failing.reason === 'runs_failed'
          ? `⚠️ فشلت مزامنة ${failing.supplierNameAr} ${failing.failedRuns} مرات متتالية${failing.errorCode ? ` (${failing.errorCode})` : ''}`
          : `⛔ أسعار ${failing.supplierNameAr} قديمة: ${failing.unavailableProducts} باقة غير متوفرة`,
        `${links.admin}/suppliers/${failing.supplier}`,
      ].join('\n');
    }
  }
}

/** Rule AL3. */
function summaryText(summary: TelegramMessageParams<'daily_summary'>): string {
  const credited =
    summary.credited.length > 0
      ? summary.credited.map(
          (row) => `• ${METHODS[row.method]}: ${row.count} بقيمة ${formatUsd(row.usdUnits)}`,
        )
      : ['• لا شيء'];
  return [
    `📊 ملخص ${summary.date}`,
    'الإيداعات المضافة:',
    ...credited,
    `منها من تيليجرام: ${summary.approvedFromTelegram}`,
    `مرفوضة: ${summary.rejected} · منتهية: ${summary.expired}`,
    `بانتظار المراجعة الآن: ${summary.waiting}${summary.oldestWaitMinutes === null ? '' : `، أقدمها منذ ${waitText(summary.oldestWaitMinutes)}`}`,
    `تحويلات USDT غير مطابقة: ${summary.unmatchedToday} اليوم، ${summary.unmatchedOpen} مفتوحة`,
    `عملاء جدد: ${summary.newCustomers}`,
    `أرصدة العملاء الحقيقيين: ${formatUsd(summary.walletsTotalUsdUnits)}`,
    `التسجيل: ${summary.registrationOpen ? 'مفتوح' : 'مغلق'}`,
    ...summary.activeSwitches.map(
      (active) => `⛔ ${SWITCH_NAMES[active.switch]} منذ ${atDamascus(new Date(active.since))}`,
    ),
    `مراجعات أسعار مفتوحة: ${summary.openReviews}`,
    ...(summary.marginGuarded > 0 ? [`باقات أوقفها حارس الهامش: ${summary.marginGuarded}`] : []),
    ...summary.suppliersNotHealthy.map(
      (supplier) => `⚠️ المورد ${supplier.supplierNameAr}: ${HEALTH[supplier.state]}`,
    ),
    ...summary.balancesLow.map(
      (supplier) =>
        `💰 رصيد ${supplier.supplierNameAr} تحت الحد: ${balanceText(supplier.currency, supplier.amountUnits)}`,
    ),
    ...(summary.suppressedAlerts > 0
      ? [`تنبيهات حُجبت بحد الإرسال: ${summary.suppressedAlerts}`]
      : []),
  ].join('\n');
}

/** What a deposit card shows (rules TC2, TC3, TC6), loaded fresh by `telegram.deposit-card`. */
export interface DepositCardView {
  id: string;
  referenceCode: string;
  method: DepositMethod;
  currency: 'SYP' | 'USD';
  declaredAmountUnits: number;
  declaredUsdUnits: number;
  /** The quote's rate for SYP. */
  rate: string | null;
  customerName: string;
  /** Credited deposits of the customer before this one; 0 is a new account. */
  creditedCount: number;
  flags: DepositFlagCode[];
  submittedAt: Date;
  /** Sham Cash: the approval offered, or why not. */
  approval: { creditUsdUnits: number } | { refusal: TelegramApprovalRefusal };
  /** USDT reviews (rule TC3). */
  usdt: { receivedUnits: number; expectedUnits: number; txid: string } | null;
  /** Null while it waits; else what the card is edited to (rule TC6). */
  outcome:
    | { kind: 'credited'; creditedUsdUnits: number; channel: 'admin' | 'telegram' | 'worker' }
    | { kind: 'rejected'; reason: DepositRejectReason }
    | { kind: 'receipt_requested' }
    | { kind: 'expired' }
    | { kind: 'cancelled' }
    | null;
}

const OUTCOME_CHANNELS = { admin: 'من اللوحة', telegram: 'من تيليجرام', worker: 'تلقائياً' };

function outcomeLine(outcome: NonNullable<DepositCardView['outcome']>): string {
  switch (outcome.kind) {
    case 'credited':
      return `✅ أُضيف ${formatUsd(outcome.creditedUsdUnits)} (${OUTCOME_CHANNELS[outcome.channel]})`;
    case 'rejected':
      return `❌ رُفض: ${REJECT_REASONS[outcome.reason]}`;
    case 'receipt_requested':
      return '↩️ طُلب إيصال أوضح';
    case 'expired':
      return '⌛ انتهت مهلته';
    case 'cancelled':
      return '🚫 ألغاه العميل';
  }
}

/** A deposit card's caption and buttons; at most 1024 characters, Telegram's caption limit. */
export function renderDepositCard(
  card: DepositCardView,
  links: TelegramLinks,
): RenderedTelegramMessage {
  const amount =
    card.currency === 'SYP'
      ? `${formatSyp(card.declaredAmountUnits)} ≈ ${formatUsd(card.declaredUsdUnits)}${card.rate ? ` (السعر ${card.rate})` : ''}`
      : formatUsd(card.declaredAmountUnits);
  const lines = [
    card.usdt
      ? `🔎 مراجعة USDT ${card.referenceCode} · ${METHODS[card.method]}`
      : `🧾 إيداع شام كاش ${card.referenceCode}`,
    card.usdt
      ? `المستلم ${formatUsdtAmount(card.usdt.receivedUnits)} USDT، المطلوب ${formatUsdtAmount(card.usdt.expectedUnits)}`
      : `المبلغ: ${amount}`,
    `العميل: ${card.customerName.slice(0, 60)} · ${card.creditedCount === 0 ? 'حساب جديد' : `${card.creditedCount} إيداعات سابقة`}`,
    ...(card.flags.length > 0 ? [`⚠️ ${card.flags.map((flag) => FLAGS[flag]).join('، ')}`] : []),
    ...(card.usdt
      ? [
          `TXID: ${shorten(card.usdt.txid)} ${USDT_NETWORKS[card.method === 'sham_cash' ? 'usdt_trc20' : card.method].explorerTxUrl(card.usdt.txid)}`,
        ]
      : []),
    `أُرسل: ${atDamascus(card.submittedAt)}`,
    `${links.admin}/deposits/${card.id}`,
  ];
  if (card.outcome) return { text: [outcomeLine(card.outcome), ...lines].join('\n'), buttons: [] };
  const approve =
    'creditUsdUnits' in card.approval
      ? [
          {
            text: `اعتماد ${formatUsd(card.approval.creditUsdUnits)}`,
            data: telegramCallbackData({ action: 'approve', depositId: card.id }),
          },
        ]
      : [];
  if ('refusal' in card.approval && !card.usdt)
    lines.push(APPROVAL_REFUSALS[card.approval.refusal]);
  return {
    text: lines.join('\n'),
    buttons: [
      [
        ...approve,
        { text: 'رفض', data: telegramCallbackData({ action: 'reject', depositId: card.id }) },
      ],
    ],
  };
}

/** The Arabic text and buttons of an outbox row (S05 F07): what it says, nothing more. */
export function renderTelegramMessage<Kind extends TelegramMessageKind>(
  kind: Kind,
  params: TelegramMessageParams<Kind>,
  links: TelegramLinks,
): RenderedTelegramMessage {
  switch (kind) {
    case 'switch_changed': {
      const change = params as TelegramMessageParams<'switch_changed'>;
      const notice = SWITCH_NOTICES[change.switch];
      return {
        text: `${change.value ? notice.on : notice.off} (من ${CHANNELS[change.channel]})`,
      };
    }
    case 'bot_reply':
      return botReply(params as TelegramBotReply);
    case 'usdt_unmatched': {
      const transfer = params as TelegramMessageParams<'usdt_unmatched'>;
      return {
        text: [
          `⚠️ تحويل USDT غير مطابق على ${METHODS[transfer.method]}`,
          `المبلغ: ${formatUsdtAmount(transfer.amountUnits)} USDT`,
          `المرسل: ${transfer.sender}`,
          `طلبات مرشّحة: ${transfer.candidates}`,
          `${links.admin}/deposits/transfers`,
        ].join('\n'),
      };
    }
    case 'review_reminder': {
      const reminder = params as TelegramMessageParams<'review_reminder'>;
      const more = reminder.count - reminder.deposits.length;
      return {
        text: [
          `⏰ ${reminder.count} إيداع بانتظار المراجعة، أقدمها منذ ${waitText(reminder.oldestWaitMinutes)}`,
          ...reminder.deposits.map(
            (deposit) => `• ${deposit.referenceCode}: ${waitText(deposit.waitMinutes)}`,
          ),
          ...(more > 0 ? [`و ${more} غيرها`] : []),
          `${links.admin}/deposits`,
        ].join('\n'),
      };
    }
    case 'daily_summary':
      return { text: summaryText(params as TelegramMessageParams<'daily_summary'>) };
    case 'supplier_sync_summary':
    case 'supplier_health':
    case 'supplier_balance_low':
    case 'supplier_sync_failing':
      return { text: supplierText(kind, params, links) };
    case 'link_changed':
      return {
        text: 'رُبط البوت بمحادثة أخرى، فلن تصل التنبيهات إلى هنا بعد الآن. إن لم تفعل ذلك بنفسك فألغِ الربط من اللوحة فوراً.',
      };
    default:
      return { text: 'رسالة اختبار من Vertex Digital: البوت مربوط ويعمل ✅' };
  }
}
