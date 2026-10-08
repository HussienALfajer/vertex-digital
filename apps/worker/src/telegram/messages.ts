import {
  type StopScope,
  type StoreSwitch,
  type SwitchChannel,
  type TelegramBotReply,
  type TelegramMessageKind,
  type TelegramMessageParams,
  telegramCallbackData,
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
};

const SCOPES: Record<StopScope, string> = {
  purchases: 'الشراء',
  deposits: 'الإيداعات',
  both: 'الشراء والإيداعات',
};

const REOPEN = 'إعادة الفتح من اللوحة فقط.';

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
        buttons: [
          [
            {
              text: 'تأكيد',
              data: telegramCallbackData({ action: 'confirm', promptId: reply.promptId }),
            },
            {
              text: 'إلغاء',
              data: telegramCallbackData({ action: 'cancel', promptId: reply.promptId }),
            },
          ],
        ],
      };
    case 'failed':
      return { text: 'تعذّر تنفيذ الطلب. حاول من اللوحة.' };
    case 'status':
      return { text: statusText(reply) };
  }
}

/** The Arabic text and buttons of an outbox row (S05 F07): what it says, nothing more. */
export function renderTelegramMessage<Kind extends TelegramMessageKind>(
  kind: Kind,
  params: TelegramMessageParams<Kind>,
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
    case 'link_changed':
      return {
        text: 'رُبط البوت بمحادثة أخرى، فلن تصل التنبيهات إلى هنا بعد الآن. إن لم تفعل ذلك بنفسك فألغِ الربط من اللوحة فوراً.',
      };
    default:
      return { text: 'رسالة اختبار من Vertex Digital: البوت مربوط ويعمل ✅' };
  }
}
