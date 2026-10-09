import { describe, expect, it } from 'vitest';
import { QUEUES } from './jobs.js';
import {
  CODE_EMAIL_TEMPLATES,
  customerNotificationSchema,
  EMAIL_PARAMS,
  EMAIL_TEMPLATES,
  isCodeEmail,
  EMAIL_NOTIFICATION_EVENTS,
  NOTIFICATION_EMAIL_TEMPLATE,
  NOTIFICATION_EVENTS,
  NOTIFICATION_PARAMS,
  notificationListQuerySchema,
  notificationPreferencesSchema,
  updateNotificationPreferenceSchema,
} from './notifications.js';

describe('email templates', () => {
  it('each have their parameters', () => {
    expect(Object.keys(EMAIL_PARAMS).sort()).toEqual([...EMAIL_TEMPLATES].sort());
  });

  it('tell code emails apart (rule E2)', () => {
    for (const template of EMAIL_TEMPLATES) {
      const code = (CODE_EMAIL_TEMPLATES as readonly string[]).includes(template);
      expect(isCodeEmail(template), template).toBe(code);
      if (code) expect(EMAIL_PARAMS[template].safeParse({ code: '123456' }).success).toBe(true);
    }
  });

  it('are sent through queues named <area>.<action>', () => {
    for (const queue of Object.values(QUEUES)) expect(queue).toMatch(/^[a-z]+\.[a-z-]+$/);
  });
});

describe('notifications (S05 F27)', () => {
  const depositId = '01920000-0000-7000-8000-000000000001';

  it('each event has its params and its email template', () => {
    expect(Object.keys(NOTIFICATION_PARAMS).sort()).toEqual([...NOTIFICATION_EVENTS].sort());
    for (const event of EMAIL_NOTIFICATION_EVENTS)
      expect(EMAIL_TEMPLATES).toContain(NOTIFICATION_EMAIL_TEMPLATE[event]);
    // S08: a delay lives in the center only, never by email.
    expect(
      NOTIFICATION_EVENTS.filter(
        (event) => !(EMAIL_NOTIFICATION_EVENTS as readonly string[]).includes(event),
      ),
    ).toEqual(['order_delayed']);
  });

  it('carry no notes, transaction numbers, TXIDs or flags (rule NT3)', () => {
    for (const event of NOTIFICATION_EVENTS)
      for (const key of Object.keys(NOTIFICATION_PARAMS[event].shape))
        expect(key, `${event}.${key}`).not.toMatch(/note|transaction|txid|flag/i);
  });

  it('render the matching email with the time added', () => {
    const params = { depositId, referenceCode: 'VD-ABC123', creditedUsdUnits: 20_000_000 };
    const at = '2026-10-08T10:00:00.000Z';
    expect(EMAIL_PARAMS.customer_deposit_credited.parse({ ...params, at })).toEqual({
      ...params,
      at,
    });
    expect(EMAIL_PARAMS.customer_deposit_credited.safeParse(params).success).toBe(false);
  });

  it('parse a notification by its event', () => {
    const base = { id: depositId, readAt: null, createdAt: '2026-10-08T10:00:00.000Z' };
    expect(
      customerNotificationSchema.parse({
        ...base,
        event: 'deposit_rejected',
        params: { depositId, referenceCode: 'VD-ABC123', reason: 'not_received' },
      }).event,
    ).toBe('deposit_rejected');
    expect(
      customerNotificationSchema.safeParse({
        ...base,
        event: 'deposit_rejected',
        params: { depositId, referenceCode: 'VD-ABC123', creditedUsdUnits: 1 },
      }).success,
    ).toBe(false);
  });

  it('page 20 by default, at most 50', () => {
    expect(notificationListQuerySchema.parse({}).limit).toBe(20);
    expect(notificationListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('keep one email choice per event', () => {
    const email = Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [event, true]));
    expect(notificationPreferencesSchema.parse({ email }).email).toEqual(email);
    expect(
      notificationPreferencesSchema.safeParse({ email: { deposit_credited: true } }).success,
    ).toBe(false);
    expect(
      updateNotificationPreferenceSchema.safeParse({ event: 'customer_new_sign_in', email: false })
        .success,
    ).toBe(false);
  });
});
