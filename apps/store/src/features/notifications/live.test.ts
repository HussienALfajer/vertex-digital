import type { CustomerNotification } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { isMoneyEvent, type LiveEvent } from './live';

const notified = (event: CustomerNotification['event']): LiveEvent => ({
  type: 'notification',
  notification: { event } as CustomerNotification,
  unreadCount: 1,
});

describe('isMoneyEvent (rule NT7)', () => {
  it('reads the balance again after every event that moves the wallet (audit A6)', () => {
    for (const event of [
      'deposit_credited',
      'wallet_adjusted',
      'order_refunded',
      'order_partially_refunded',
      'order_paid',
      'order_placed_for_you',
    ] as const) {
      expect(isMoneyEvent(notified(event))).toBe(true);
    }
    expect(isMoneyEvent({ type: 'resync' })).toBe(true);
  });

  it('ignores events that leave the balance as it is', () => {
    for (const event of ['order_delivered', 'deposit_rejected', 'ticket_replied'] as const) {
      expect(isMoneyEvent(notified(event))).toBe(false);
    }
    expect(isMoneyEvent({ type: 'unread', unreadCount: 0 })).toBe(false);
  });
});
