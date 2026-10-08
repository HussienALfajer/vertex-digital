import { z } from 'zod';
import {
  STORE_SWITCHES,
  type StoreSwitch,
  storeSwitchSchema,
  switchChannelSchema,
} from './settings.js';

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

/*
 * The outbox (`telegram_messages`): a kind and its parameters, rendered in Arabic by the worker.
 * Parameters hold what the message says and nothing more: no tokens, receipts or notes.
 */

export const TELEGRAM_MESSAGE_KINDS = [
  'switch_changed',
  'bot_reply',
  'link_changed',
  'test',
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
]);

export type TelegramBotReply = z.infer<typeof telegramBotReplySchema>;

export const TELEGRAM_MESSAGE_PARAMS = {
  /** Rule AL2: every switch change, from the panel or from Telegram. */
  switch_changed: z.object({
    switch: storeSwitchSchema,
    value: z.boolean(),
    channel: switchChannelSchema,
  }),
  bot_reply: telegramBotReplySchema,
  /** To the previous chat when another chat was linked (rule TG3). */
  link_changed: z.object({}),
  /** The panel's "إرسال رسالة اختبار". */
  test: z.object({}),
} as const satisfies Record<TelegramMessageKind, z.ZodType>;

export type TelegramMessageParams<Kind extends TelegramMessageKind> = z.infer<
  (typeof TELEGRAM_MESSAGE_PARAMS)[Kind]
>;

/*
 * Bot questions (`telegram_prompts`, rule TG7): at most one open; opening one closes the others.
 */

export const TELEGRAM_PROMPT_KINDS = ['stop_confirm'] as const;

export type TelegramPromptKind = (typeof TELEGRAM_PROMPT_KINDS)[number];

export const TELEGRAM_PROMPT_DATA = {
  stop_confirm: z.object({ scope: stopScopeSchema }),
} as const satisfies Record<TelegramPromptKind, z.ZodType>;

/*
 * Button data (rule TG6): `<prefix>:<value>`, at most 64 bytes as Telegram allows.
 */

export const TELEGRAM_CALLBACKS = { stop: 'st', confirm: 'ok', cancel: 'no' } as const;

export type TelegramCallback =
  | { action: 'stop'; scope: StopScope }
  | { action: 'confirm' | 'cancel'; promptId: string };

const callbackActions = Object.fromEntries(
  Object.entries(TELEGRAM_CALLBACKS).map(([action, prefix]) => [prefix, action]),
) as Record<string, TelegramCallback['action']>;

export function telegramCallbackData(callback: TelegramCallback): string {
  const value = callback.action === 'stop' ? callback.scope : callback.promptId;
  return `${TELEGRAM_CALLBACKS[callback.action]}:${value}`;
}

/** The button pressed, or null for data this bot never sent. */
export function parseTelegramCallback(data: string): TelegramCallback | null {
  const separator = data.indexOf(':');
  const action = callbackActions[data.slice(0, separator)];
  const value = data.slice(separator + 1);
  if (separator < 0 || !action) return null;
  if (action === 'stop') {
    const scope = stopScopeSchema.safeParse(value);
    return scope.success ? { action, scope: scope.data } : null;
  }
  return z.uuid().safeParse(value).success ? { action, promptId: value } : null;
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
