import { describe, expect, it } from 'vitest';
import { backupCodeSchema, signInSchema, totpCodeSchema } from './auth.js';

describe('sign-in', () => {
  it('needs an email and a password', () => {
    expect(signInSchema.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(true);
    expect(signInSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
    expect(signInSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
  });
});

describe('two-factor codes', () => {
  it('accepts six digits only as a TOTP code', () => {
    expect(totpCodeSchema.safeParse('012345').success).toBe(true);
    for (const code of ['12345', '1234567', '12a456', ' 123456']) {
      expect(totpCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });

  it('accepts a backup code as written, forgiving case and spaces', () => {
    expect(backupCodeSchema.parse(' ABCDE-fghjk ')).toBe('abcde-fghjk');
    for (const code of ['abcde-fghj', 'abcdefghjk', 'abcde-fghi1', 'abcde-0ghjk']) {
      expect(backupCodeSchema.safeParse(code).success, code).toBe(false);
    }
  });
});
