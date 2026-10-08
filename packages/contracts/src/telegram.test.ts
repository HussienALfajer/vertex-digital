import { describe, expect, it } from 'vitest';
import { STORE_SWITCH_DEFAULTS } from './settings.js';
import {
  parseTelegramCallback,
  STOP_SCOPE_SWITCHES,
  STOP_SCOPES,
  TELEGRAM_CALLBACKS,
  TELEGRAM_MESSAGE_PARAMS,
  type TelegramCallback,
  telegramCallbackData,
  telegramLinkCodeValueSchema,
  telegramUpdateSchema,
} from './telegram.js';

const promptId = '0199c2a0-7a1e-7c3b-9f00-0123456789ab';

describe('Telegram button data (S05 rule TG6)', () => {
  const callbacks: TelegramCallback[] = [
    ...STOP_SCOPES.map((scope) => ({ action: 'stop', scope }) as const),
    { action: 'confirm', promptId },
    { action: 'cancel', promptId },
  ];

  it('round-trips every button within 64 bytes', () => {
    for (const callback of callbacks) {
      const data = telegramCallbackData(callback);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parseTelegramCallback(data)).toEqual(callback);
    }
    expect(telegramCallbackData({ action: 'confirm', promptId })).toBe(`ok:${promptId}`);
    expect(Object.values(TELEGRAM_CALLBACKS)).toEqual(['st', 'ok', 'no']);
  });

  it('refuses data this bot never sent', () => {
    for (const data of [
      '',
      'st',
      'st:',
      'st:everything',
      'ok:42',
      'zz:both',
      ':both',
      'no',
      `constructor:${promptId}`,
      `toString:${promptId}`,
    ]) {
      expect(parseTelegramCallback(data)).toBeNull();
    }
  });
});

describe('Telegram stops (S05 rule AL4)', () => {
  it('turn on the purchase stop, the deposit stop, or both', () => {
    expect(STOP_SCOPE_SWITCHES).toEqual({
      purchases: ['purchases_stopped'],
      deposits: ['deposits_stopped'],
      both: ['purchases_stopped', 'deposits_stopped'],
    });
  });
});

describe('Telegram messages', () => {
  it('validate each kind by its parameters', () => {
    expect(
      TELEGRAM_MESSAGE_PARAMS.switch_changed.parse({
        switch: 'deposits_stopped',
        value: true,
        channel: 'telegram',
      }),
    ).toBeTruthy();
    expect(TELEGRAM_MESSAGE_PARAMS.bot_reply.parse({ reply: 'help' })).toEqual({ reply: 'help' });
    expect(
      TELEGRAM_MESSAGE_PARAMS.bot_reply.parse({
        reply: 'status',
        switches: STORE_SWITCH_DEFAULTS,
        waiting: 2,
        unmatchedTransfers: 0,
      }),
    ).toBeTruthy();
    // A status reply carries every switch.
    expect(
      TELEGRAM_MESSAGE_PARAMS.bot_reply.safeParse({
        reply: 'status',
        switches: { registration_open: true },
        waiting: 0,
        unmatchedTransfers: 0,
      }).success,
    ).toBe(false);
    expect(
      TELEGRAM_MESSAGE_PARAMS.bot_reply.safeParse({ reply: 'stop_confirm', promptId, scope: 'all' })
        .success,
    ).toBe(false);
  });
});

describe('Telegram linking (S05 rule TG3)', () => {
  it('takes a 22-character base64url code only', () => {
    expect(telegramLinkCodeValueSchema.safeParse('AbCdEfGhIjKlMnOpQrSt-_').success).toBe(true);
    for (const code of ['short', 'AbCdEfGhIjKlMnOpQrSt-_x', 'AbCdEfGhIjKlMnOpQrSt+/']) {
      expect(telegramLinkCodeValueSchema.safeParse(code).success).toBe(false);
    }
  });
});

describe('Telegram updates', () => {
  it('keep the fields the bot reads and drop the rest', () => {
    const update = telegramUpdateSchema.parse({
      update_id: 10,
      message: {
        message_id: 5,
        date: 1_700_000_000,
        from: { id: 42, is_bot: false, first_name: 'A', username: 'owner' },
        chat: { id: 42, type: 'private', first_name: 'A' },
        text: '/status',
      },
    });
    expect(update).toEqual({
      update_id: 10,
      message: {
        message_id: 5,
        from: { id: 42, username: 'owner' },
        chat: { id: 42, type: 'private' },
        text: '/status',
      },
    });
    expect(
      telegramUpdateSchema.safeParse({
        update_id: 11,
        callback_query: { id: 'q', from: { id: 42 }, data: 'x'.repeat(65) },
      }).success,
    ).toBe(false);
  });
});
