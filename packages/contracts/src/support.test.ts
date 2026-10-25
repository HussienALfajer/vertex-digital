import { describe, expect, it } from 'vitest';
import {
  adminCreateTicketSchema,
  adminTicketListQuerySchema,
  autoCloseBefore,
  createTicketSchema,
  customerCanReply,
  type OrderProblemFacts,
  type OrderProblemsView,
  orderProblemAllowed,
  orderProblemsFor,
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

describe('order problems (S22 OP2-OP4)', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
  const order = (
    status: OrderProblemFacts['status'],
    productKind: OrderProblemFacts['productKind'] = 'direct',
    finishedAt: Date | null = null,
  ): OrderProblemFacts => ({ status, productKind, paidAt: minutesAgo(1), finishedAt });
  const problems = (view: OrderProblemsView) =>
    view.state === 'open' ? view.problems.map((option) => option.problem) : view.state;
  const hints = (view: OrderProblemsView) =>
    view.state === 'open' ? view.problems.map(({ problem: _, ...rest }) => rest) : [];

  it('offer the problems of each state and kind', () => {
    for (const status of ['paid', 'sent_to_supplier', 'needs_review'] as const)
      expect(problems(orderProblemsFor(order(status), now, 600))).toEqual([
        'not_arrived',
        'wrong_player_id',
        'other',
      ]);
    expect(problems(orderProblemsFor(order('delivered', 'direct', now), now, 600))).toEqual([
      'not_arrived',
      'wrong_amount',
      'wrong_player_id',
      'other',
    ]);
    expect(problems(orderProblemsFor(order('delivered', 'code', now), now, 600))).toEqual([
      'code_not_working',
      'code_used',
      'wrong_region',
      'other',
    ]);
    expect(problems(orderProblemsFor(order('partially_refunded', 'code', now), now, 600))).toEqual([
      'code_not_working',
      'code_used',
      'wrong_region',
      'other',
      'refund_missing',
    ]);
    expect(problems(orderProblemsFor(order('refunded', 'direct', now), now, 600))).toEqual([
      'refund_missing',
      'other',
    ]);
    // `failed` is still on its way (back to a supplier or to a refund): no refund problem yet.
    expect(problems(orderProblemsFor(order('failed'), now, 600))).toEqual([
      'not_arrived',
      'wrong_player_id',
      'other',
    ]);
    expect(orderProblemAllowed(order('failed'), 'refund_missing', now)).toBe('state');
    expect(orderProblemsFor(order('awaiting_balance'), now, 600)).toEqual({ state: 'none' });
    expect(orderProblemsFor(order('cancelled', 'direct', now), now, 600)).toEqual({
      state: 'none',
    });
  });

  it('close 7 days after the order finished (OP3)', () => {
    const open = order('delivered', 'direct', new Date(daysAgo(7).getTime() + 1));
    const closed = order('delivered', 'direct', daysAgo(7));
    expect(orderProblemsFor(open, now, 600).state).toBe('open');
    expect(orderProblemsFor(closed, now, 600)).toEqual({ state: 'window_closed' });
  });

  it('name each hint (OP4)', () => {
    // Within the product's usual time: the minutes, rounded up.
    expect(hints(orderProblemsFor(order('paid'), now, 150))).toEqual([
      { hint: 'usual_time', usualMinutes: 3 },
      { hint: 'player_id_locked' },
      { hint: null },
    ]);
    // Past it, or never paid: no hint.
    expect(hints(orderProblemsFor(order('paid'), now, 60))[0]).toEqual({ hint: null });
    expect(hints(orderProblemsFor({ ...order('paid'), paidAt: null }, now, 600))[0]).toEqual({
      hint: null,
    });
    expect(hints(orderProblemsFor(order('delivered', 'direct', now), now, 600))).toEqual([
      { hint: 'game_delay' },
      { hint: null },
      { hint: 'delivered_to_id' },
      { hint: null },
    ]);
    expect(hints(orderProblemsFor(order('partially_refunded', 'code', now), now, 600))).toEqual([
      { hint: 'code_help' },
      { hint: 'code_help' },
      { hint: 'code_help' },
      { hint: null },
      { hint: 'refund_returned' },
    ]);
  });

  it('are checked again by the server (OP3, edge cases 13 and 14)', () => {
    expect(orderProblemAllowed(order('paid'), 'not_arrived', now)).toBeNull();
    expect(orderProblemAllowed(order('paid'), 'refund_missing', now)).toBe('state');
    expect(orderProblemAllowed(order('awaiting_balance'), 'other', now)).toBe('state');
    expect(orderProblemAllowed(order('delivered', 'direct', now), 'code_used', now)).toBe('kind');
    expect(orderProblemAllowed(order('delivered', 'code', now), 'wrong_amount', now)).toBe('kind');
    expect(orderProblemAllowed(order('delivered', 'direct', daysAgo(8)), 'not_arrived', now)).toBe(
      'window_closed',
    );
  });

  it('go with the order category only (OP5)', () => {
    const ticket = { category: 'order', orderId: ORDER, subject: 'late order', body: 'x' };
    expect(createTicketSchema.parse({ ...ticket, orderProblem: 'not_arrived' }).orderProblem).toBe(
      'not_arrived',
    );
    expect(createTicketSchema.parse({ ...ticket, orderProblem: '' }).orderProblem).toBeUndefined();
    const other = { ...ticket, category: 'other', orderId: undefined, orderProblem: 'other' };
    expect(createTicketSchema.safeParse(other).success).toBe(false);
    expect(adminTicketListQuerySchema.parse({ problem: 'code_used' }).problem).toBe('code_used');
  });
});
