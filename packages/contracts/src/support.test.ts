import { describe, expect, it } from 'vitest';
import {
  adminCreateTicketSchema,
  adminTicketListQuerySchema,
  autoCloseBefore,
  createTicketSchema,
  customerCanReply,
  supportSettingsSchema,
  TICKET_LIMITS,
  TICKET_STATUSES,
  type TicketEvent,
  ticketBodySchema,
  ticketLinkValid,
  ticketNoticeKey,
  ticketNumberSchema,
  ticketSubjectSchema,
  ticketTransition,
} from './support.js';

const DAY = 24 * 60 * 60 * 1000;
const ORDER = '0199a000-0000-7000-8000-000000000001';
const DEPOSIT = '0199a000-0000-7000-8000-000000000002';

describe('ticket transitions (TK3–TK5)', () => {
  const expected: Record<string, Record<TicketEvent, string | null>> = {
    open: { customer_message: 'open', admin_message: 'answered', close: 'closed' },
    answered: { customer_message: 'open', admin_message: 'answered', close: 'closed' },
    closed: { customer_message: 'open', admin_message: 'answered', close: null },
  };
  for (const status of TICKET_STATUSES) {
    for (const event of ['customer_message', 'admin_message', 'close'] as const) {
      it(`${status} + ${event} → ${expected[status]?.[event]}`, () => {
        expect(ticketTransition(status, event)).toBe(expected[status]?.[event]);
      });
    }
  }
});

describe('customer replies on closed tickets (TK4)', () => {
  const closedAt = new Date('2026-10-01T10:00:00Z');

  it('are allowed on open tickets and within 7 days of closing', () => {
    expect(customerCanReply({ status: 'open', closedAt: null }, new Date())).toBe(true);
    expect(customerCanReply({ status: 'answered', closedAt: null }, new Date())).toBe(true);
    const edge = new Date(closedAt.getTime() + TICKET_LIMITS.reopenDays * DAY);
    expect(customerCanReply({ status: 'closed', closedAt }, edge)).toBe(true);
  });

  it('are refused past 7 days', () => {
    const late = new Date(closedAt.getTime() + TICKET_LIMITS.reopenDays * DAY + 1);
    expect(customerCanReply({ status: 'closed', closedAt }, late)).toBe(false);
  });

  it('auto-close takes answered tickets whose admin message is 7 days old (TK6)', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(autoCloseBefore(now).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
});

describe('ticket links (TK1)', () => {
  it('need an order for order tickets and a deposit for deposit tickets', () => {
    expect(ticketLinkValid({ category: 'order', orderId: ORDER })).toBe(true);
    expect(ticketLinkValid({ category: 'order' })).toBe(false);
    expect(ticketLinkValid({ category: 'order', orderId: ORDER, depositId: DEPOSIT })).toBe(false);
    expect(ticketLinkValid({ category: 'deposit', depositId: DEPOSIT })).toBe(true);
    expect(ticketLinkValid({ category: 'deposit', orderId: ORDER })).toBe(false);
  });

  it('refuse a link on account and other tickets', () => {
    expect(ticketLinkValid({ category: 'account', orderId: null, depositId: null })).toBe(true);
    expect(ticketLinkValid({ category: 'other', depositId: DEPOSIT })).toBe(false);
  });
});

describe('ticket inputs', () => {
  it('trim the subject to 3–120 characters on one line', () => {
    expect(ticketSubjectSchema.parse('  أين طلبي؟ ')).toBe('أين طلبي؟');
    expect(ticketSubjectSchema.safeParse('ab').success).toBe(false);
    expect(ticketSubjectSchema.safeParse('a'.repeat(121)).success).toBe(false);
    expect(ticketSubjectSchema.safeParse('سطر\nآخر').success).toBe(false);
  });

  it('keep new lines in the body and refuse other control characters', () => {
    expect(ticketBodySchema.parse(' سطر\r\nثانٍ ')).toBe('سطر\nثانٍ');
    expect(ticketBodySchema.safeParse('   ').success).toBe(false);
    expect(ticketBodySchema.safeParse('a'.repeat(2001)).success).toBe(false);
    expect(ticketBodySchema.safeParse('bell\u0007').success).toBe(false);
  });

  it('read empty multipart ids as none', () => {
    const ticket = { category: 'other', orderId: '', subject: 'سؤال', body: 'نص' };
    expect(createTicketSchema.parse(ticket)).toEqual({
      category: 'other',
      orderId: undefined,
      depositId: undefined,
      subject: 'سؤال',
      body: 'نص',
    });
    expect(
      adminCreateTicketSchema.safeParse({ ...ticket, customerId: ORDER, orderId: ORDER }).success,
    ).toBe(true);
  });

  it('normalize ticket numbers as typed', () => {
    expect(ticketNumberSchema.parse(' vt7kq2mx ')).toBe('VT-7KQ2MX');
    expect(ticketNumberSchema.safeParse('VT-7KQ2M0').success).toBe(false);
  });

  it('default the admin queue to tickets waiting for the admin, 25 a page', () => {
    expect(adminTicketListQuerySchema.parse({})).toEqual({ status: 'open', limit: 25 });
  });
});

describe('support settings (SC1)', () => {
  it('take only a t.me link, or none', () => {
    expect(supportSettingsSchema.parse({ telegramUrl: 'https://t.me/vertex_support' })).toEqual({
      telegramUrl: 'https://t.me/vertex_support',
    });
    expect(supportSettingsSchema.parse({ telegramUrl: null })).toEqual({ telegramUrl: null });
    for (const url of ['http://t.me/vertex_support', 'https://t.me/abc', 'https://evil.me/abcde']) {
      expect(supportSettingsSchema.safeParse({ telegramUrl: url }).success).toBe(false);
    }
  });
});

describe('ticket notices (TK8, TK9)', () => {
  it('group a ticket per 10-minute window', () => {
    const at = new Date('2026-10-10T10:00:00Z');
    const key = ticketNoticeKey(ORDER, at);
    expect(ticketNoticeKey(ORDER, new Date(at.getTime() + 9 * 60 * 1000))).toBe(key);
    expect(ticketNoticeKey(ORDER, new Date(at.getTime() + 10 * 60 * 1000))).not.toBe(key);
    expect(key.startsWith(`ticket:${ORDER}:`)).toBe(true);
  });
});
