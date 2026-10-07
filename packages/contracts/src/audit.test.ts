import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUDIT_ACTIONS, AUDIT_DETAILS, auditListQuerySchema } from './audit.js';

/** Keys that would put a secret in the audit log (rule A2, `details`). */
const SECRET_KEY = /password|hash|otp|code|secret|token|session_?id|backup|totp|cookie|key/i;

function keysOf(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([key, value]) => [
      key,
      ...keysOf(value),
    ]);
  }
  if (schema instanceof z.ZodOptional) return keysOf(schema.unwrap() as z.ZodType);
  return [];
}

describe('audit actions', () => {
  it('are <entity>.<verb> in snake case', () => {
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('never carry a password, code, secret or token in their details', () => {
    const offenders = AUDIT_ACTIONS.flatMap((action) =>
      keysOf(AUDIT_DETAILS[action])
        .filter((key) => SECRET_KEY.test(key))
        .map((key) => `${action}: ${key}`),
    );
    expect(offenders).toEqual([]);
    // The check itself finds a secret key, nested or not.
    const nested = z.object({ a: z.object({ resetToken: z.string() }).optional() });
    expect(keysOf(nested)).toContain('resetToken');
  });

  it('refuse details beyond their shape', () => {
    expect(AUDIT_DETAILS['admin.signed_in'].safeParse({}).success).toBe(true);
    expect(AUDIT_DETAILS['admin.signed_in'].safeParse({ password: 'x' }).success).toBe(false);
    const update = { before: { name: 'A' }, after: { name: 'B' } };
    expect(AUDIT_DETAILS['customer.profile_updated'].safeParse(update).success).toBe(true);
  });
});

describe('the audit list query', () => {
  it('defaults to 50 entries and takes the filters of the screen', () => {
    expect(auditListQuerySchema.parse({})).toEqual({ limit: 50 });
    const filters = {
      actorKind: 'customer',
      actorId: '0199a000-0000-7000-8000-000000000001',
      action: 'customer.email_changed',
      entityType: 'customer',
      entityId: '0199a000-0000-7000-8000-000000000001',
      from: '2026-10-01T00:00:00+03:00',
      to: '2026-10-07T00:00:00Z',
    };
    expect(auditListQuerySchema.parse({ ...filters, limit: '20' })).toEqual({
      ...filters,
      limit: 20,
    });
    expect(auditListQuerySchema.safeParse({ action: 'customer.deleted' }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
