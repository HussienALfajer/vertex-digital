import { describe, expect, it } from 'vitest';
import { newTicketHref } from './labels';

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
