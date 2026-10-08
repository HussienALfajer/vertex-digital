import type { CustomerNotification } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { ltr } from '@/lib/format';
import { badgeText, notificationHref, notificationText } from './labels';

const base = { id: 'n1', readAt: null, createdAt: '2026-10-08T10:00:00.000Z' };
const depositId = '01920000-0000-7000-8000-000000000001';

describe('notification labels', () => {
  it('say what happened from the params (rule NT3)', () => {
    const credited: CustomerNotification = {
      ...base,
      event: 'deposit_credited',
      params: { depositId, referenceCode: 'VD-ABC23', creditedUsdUnits: 20_000_000 },
    };
    expect(notificationText(credited)).toBe(
      `أُضيف ${ltr('$20.00')} إلى رصيدك (${ltr('VD-ABC23')}).`,
    );
    expect(
      notificationText({
        ...base,
        event: 'deposit_rejected',
        params: { depositId, referenceCode: 'VD-ABC23', reason: 'not_received' },
      }),
    ).toBe(`رُفض الإيداع ${ltr('VD-ABC23')}: لم يصل التحويل إلى حسابنا.`);
    expect(
      notificationText({
        ...base,
        event: 'deposit_receipt_requested',
        params: { depositId, referenceCode: 'VD-ABC23' },
      }),
    ).toContain(ltr('VD-ABC23'));
    expect(
      notificationText({
        ...base,
        event: 'wallet_adjusted',
        params: {
          direction: 'debit',
          amountUnits: 5_000_000,
          category: 'correction',
          reversal: true,
        },
      }),
    ).toBe(`خصمت الإدارة ${ltr('$5.00')} من رصيدك: عكس: تصحيح خطأ.`);
  });

  it('lead to the deposit or the wallet (rule NT4)', () => {
    expect(
      notificationHref({
        ...base,
        event: 'deposit_receipt_requested',
        params: { depositId, referenceCode: 'VD-ABC23' },
      }),
    ).toBe(`/wallet/deposits/${depositId}`);
    expect(
      notificationHref({
        ...base,
        event: 'wallet_adjusted',
        params: { direction: 'credit', amountUnits: 1, category: 'compensation', reversal: false },
      }),
    ).toBe('/wallet');
  });

  it('badge nothing at 0 and 9+ above 9', () => {
    expect([0, 1, 9, 10, 120].map(badgeText)).toEqual([null, '1', '9', '9+', '9+']);
  });
});
