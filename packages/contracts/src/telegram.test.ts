import { describe, expect, it } from 'vitest';
import { STORE_SWITCH_DEFAULTS } from './settings.js';
import {
  overdueReviews,
  parseTelegramCallback,
  reviewReminderDue,
  reviewWaitStart,
  STOP_SCOPE_SWITCHES,
  STOP_SCOPES,
  TELEGRAM_CALLBACKS,
  TELEGRAM_MESSAGE_PARAMS,
  TELEGRAM_PROMPT_DATA,
  type TelegramCallback,
  telegramApprovalRefusal,
  telegramCallbackData,
  telegramLinkCodeValueSchema,
  telegramRejectReasons,
  telegramUpdateSchema,
} from './telegram.js';

const promptId = '0199c2a0-7a1e-7c3b-9f00-0123456789ab';

describe('Telegram button data (S05 rule TG6)', () => {
  const callbacks: TelegramCallback[] = [
    ...STOP_SCOPES.map((scope) => ({ action: 'stop', scope }) as const),
    { action: 'confirm', promptId },
    { action: 'cancel', promptId },
    { action: 'approve', depositId: promptId },
    { action: 'reject', depositId: promptId },
    ...telegramRejectReasons('usdt_trc20').map(
      (reason) => ({ action: 'reason', promptId, reason }) as const,
    ),
  ];

  it('round-trips every button within 64 bytes', () => {
    for (const callback of callbacks) {
      const data = telegramCallbackData(callback);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parseTelegramCallback(data)).toEqual(callback);
    }
    expect(telegramCallbackData({ action: 'confirm', promptId })).toBe(`ok:${promptId}`);
    expect(Object.values(TELEGRAM_CALLBACKS)).toEqual(['st', 'ok', 'no', 'ap', 'rj', 'rr']);
    expect(telegramCallbackData({ action: 'reason', promptId, reason: 'not_received' })).toBe(
      `rr:${promptId}:not_received`,
    );
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
      'ap:42',
      'rj:',
      `rr:${promptId}`,
      `rr:${promptId}:other`,
      `rr:${promptId}:not_received:x`,
      'rr:42:not_received',
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

  it('read a daily summary queued before S07 with the supplier lines empty', () => {
    const summary = TELEGRAM_MESSAGE_PARAMS.daily_summary.parse({
      date: '2026-10-08',
      credited: [],
      approvedFromTelegram: 0,
      rejected: 0,
      expired: 0,
      waiting: 0,
      oldestWaitMinutes: null,
      unmatchedToday: 0,
      unmatchedOpen: 0,
      newCustomers: 0,
      walletsTotalUsdUnits: 0,
      registrationOpen: true,
      activeSwitches: [],
      suppressedAlerts: 0,
    });
    expect(summary).toMatchObject({
      openReviews: 0,
      marginGuarded: 0,
      suppliersNotHealthy: [],
      balancesLow: [],
      ordersDelivered: 0,
      ordersPartiallyRefunded: 0,
      ordersRefunded: 0,
      ordersInReview: 0,
      manualWaiting: 0,
      medianDeliveryMs: null,
    });
  });

  it('carry no field values or codes in the order messages (S08)', () => {
    const orderId = '0199c3a4-0000-7000-8000-000000000001';
    expect(
      Object.keys(
        TELEGRAM_MESSAGE_PARAMS.manual_order.parse({
          orderId,
          orderNumber: 'VO-ABC234',
          gameNameAr: 'ببجي',
          productNameAr: '60 UC',
          quantity: 1,
          sentAt: '2026-10-09T10:00:00.000Z',
          fields: { player_id: '5123456789' },
        }),
      ),
    ).not.toContain('fields');
    expect(
      TELEGRAM_MESSAGE_PARAMS.order_conflict.safeParse({
        orderId,
        orderNumber: 'VO-ABC234',
        supplierNameAr: 'WDGZone',
        attemptStatus: 'delivered',
        reported: 'pending',
      }).success,
    ).toBe(false);
  });

  it('tell a failing sync from stale costs (S07)', () => {
    const stale = TELEGRAM_MESSAGE_PARAMS.supplier_sync_failing.parse({
      reason: 'costs_stale',
      supplier: 'fake',
      supplierNameAr: 'مورد تجريبي',
      unavailableProducts: 14,
    });
    expect(stale.reason).toBe('costs_stale');
    expect(
      TELEGRAM_MESSAGE_PARAMS.supplier_sync_failing.safeParse({
        reason: 'runs_failed',
        supplier: 'fake',
        supplierNameAr: 'مورد تجريبي',
        failedRuns: 0,
        errorCode: null,
      }).success,
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

describe('Decisions from Telegram (S05 rules TC4, TC5)', () => {
  it('offer the panel reasons without "other", the USDT ones for USDT only', () => {
    expect(telegramRejectReasons('sham_cash')).toEqual([
      'not_received',
      'receipt_invalid',
      'receipt_used',
      'reference_other_customer',
      'wrong_account',
    ]);
    expect(telegramRejectReasons('usdt_bep20')).toContain('transfer_other_customer');
    expect(telegramRejectReasons('usdt_bep20')).not.toContain('other');
  });

  it('approve only an unflagged Sham Cash deposit within the limit', () => {
    const base = {
      method: 'sham_cash' as const,
      flagCount: 0,
      creditUsdUnits: 100,
      limitUsdUnits: 100,
    };
    expect(telegramApprovalRefusal(base)).toBeNull();
    expect(telegramApprovalRefusal({ ...base, method: 'usdt_trc20' })).toBe('panel_only');
    expect(telegramApprovalRefusal({ ...base, method: 'sham_cash', limitUsdUnits: 0 })).toBe('off');
    expect(telegramApprovalRefusal({ ...base, method: 'sham_cash', flagCount: 1 })).toBe('flagged');
    expect(telegramApprovalRefusal({ ...base, method: 'sham_cash', creditUsdUnits: 101 })).toBe(
      'over_limit',
    );
  });

  it('validate the answers to prompts', () => {
    expect(TELEGRAM_PROMPT_DATA.approve_confirm.parse({ transactionNumber: ' 12 ' })).toEqual({
      transactionNumber: '12',
    });
    expect(TELEGRAM_PROMPT_DATA.reject_note.parse({ reason: null })).toEqual({ reason: null });
  });
});

describe('The review reminder (S05 rules RM1–RM4)', () => {
  const hours = { start: '10:00', end: '22:00' };
  // Damascus is UTC+3: 10:00 there is 07:00Z.
  const at = (iso: string) => new Date(iso);

  it('counts a wait from the submission, or from the next opening outside hours', () => {
    expect(reviewWaitStart(at('2026-10-08T08:00:00Z'), hours)).toEqual(at('2026-10-08T08:00:00Z'));
    expect(reviewWaitStart(at('2026-10-08T20:00:00Z'), hours)).toEqual(at('2026-10-09T07:00:00Z'));
  });

  it('lists the overdue reviews oldest first', () => {
    const now = at('2026-10-09T07:15:00Z');
    const reviews = [
      { id: 'night', submittedAt: at('2026-10-08T20:00:00Z'), remindedAt: null },
      { id: 'fresh', submittedAt: at('2026-10-09T07:05:00Z'), remindedAt: null },
      { id: 'old', submittedAt: at('2026-10-08T18:00:00Z'), remindedAt: null },
    ];
    expect(overdueReviews(reviews, now, hours, 15).map((review) => review.id)).toEqual([
      'old',
      'night',
    ]);
    const [, night] = overdueReviews(reviews, now, hours, 15);
    expect(night).toMatchObject({ waitMinutes: 15, overdueAt: now });
  });

  it('reminds at the target, then every 30 minutes, within hours only (rule RM4)', () => {
    const submittedAt = at('2026-10-08T20:00:00Z');
    const due = (now: Date, lastReminderAt: Date | null, remindedAt: Date | null = null) =>
      reviewReminderDue({
        now,
        hours,
        lastReminderAt,
        overdue: overdueReviews([{ submittedAt, remindedAt }], now, hours, 15),
      });
    // 23:00 in Damascus: outside hours.
    expect(due(at('2026-10-08T20:05:00Z'), null)).toBe(false);
    expect(due(at('2026-10-09T07:10:00Z'), null)).toBe(false);
    expect(due(at('2026-10-09T07:15:00Z'), null)).toBe(true);
    const first = at('2026-10-09T07:15:00Z');
    expect(due(at('2026-10-09T07:40:00Z'), first, first)).toBe(false);
    expect(due(at('2026-10-09T07:45:00Z'), first, first)).toBe(true);
    // A review that became overdue after the last reminder is listed at once.
    expect(due(at('2026-10-09T07:20:00Z'), at('2026-10-09T07:00:00Z'))).toBe(true);
    // Nothing overdue: nothing to say.
    expect(reviewReminderDue({ now: first, hours, lastReminderAt: null, overdue: [] })).toBe(false);
  });
});
