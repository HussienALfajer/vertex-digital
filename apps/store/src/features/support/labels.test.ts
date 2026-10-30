import { describe, expect, it } from 'vitest';
import { newTicketHref, replyPromiseText } from './labels';

describe('newTicketHref (TK4)', () => {
  it('keeps the type and the link of the closed ticket', () => {
    expect(newTicketHref({ category: 'order', order: { id: 'o1' }, deposit: null })).toBe(
      '/support/new?category=order&order=o1',
    );
    expect(newTicketHref({ category: 'deposit', order: null, deposit: { id: 'd1' } })).toBe(
      '/support/new?category=deposit&deposit=d1',
    );
    expect(newTicketHref({ category: 'account', order: null, deposit: null })).toBe(
      '/support/new?category=account',
    );
  });
});

describe('replyPromiseText (S23 OP3)', () => {
  it('says whole hours in hours and the rest in minutes', () => {
    expect(replyPromiseText(60)).toBe('نرد عادةً خلال ساعة');
    expect(replyPromiseText(120)).toBe('نرد عادةً خلال ساعتين');
    expect(replyPromiseText(180)).toBe('نرد عادةً خلال 3 ساعات');
    expect(replyPromiseText(1_440)).toBe('نرد عادةً خلال 24 ساعة');
    expect(replyPromiseText(45)).toBe('نرد عادةً خلال 45 دقيقة');
  });
});
