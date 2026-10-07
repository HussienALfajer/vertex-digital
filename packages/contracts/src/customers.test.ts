import { describe, expect, it } from 'vitest';
import { ADMIN_SESSION_RULES } from './admin.js';
import { createdTestCustomerSchema, createTestCustomerSchema } from './customers.js';
import { cursorQuerySchema } from './lists.js';

describe('test customers', () => {
  it('are created with a name, an email and a phone', () => {
    const input = { name: 'زبون تجريبي', email: 't@example.com', phone: '0944123456' };
    expect(createTestCustomerSchema.parse(input)).toEqual({ ...input, phone: '+963944123456' });
  });

  it('come back once with their password', () => {
    const created = {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'زبون تجريبي',
      email: 't@example.com',
      phone: '+963944123456',
      createdAt: '2026-10-07T10:00:00.000Z',
      password: 'generated',
    };
    expect(createdTestCustomerSchema.parse(created)).toEqual(created);
  });
});

describe('cursor lists', () => {
  it('default to 50 items and take an opaque cursor', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(cursorQuerySchema.parse({ cursor: 'abc', limit: '10' })).toEqual({
      cursor: 'abc',
      limit: 10,
    });
    expect(cursorQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('admin session rules (D4, D5)', () => {
  it('end a session after 30 idle minutes or 12 hours; re-authentication lasts 5 minutes', () => {
    expect(ADMIN_SESSION_RULES).toEqual({
      idleTimeoutMs: 1_800_000,
      absoluteLifetimeMs: 43_200_000,
      reauthenticationMs: 300_000,
    });
  });
});
