import { describe, expect, it } from 'vitest';
import {
  adminPasswordSchema,
  backupCodeSchema,
  customerSignUpSchema,
  fullNameSchema,
  isCommonPassword,
  otpCodeSchema,
  PASSWORD_EQUALS_EMAIL,
  PASSWORD_TOO_COMMON,
  passwordEqualsEmail,
  passwordSchema,
  phoneSchema,
  resetPasswordSchema,
  signInSchema,
  totpCodeSchema,
  updateCustomerProfileSchema,
} from './auth.js';

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

describe('passwords (rules C3, D6)', () => {
  it('take 8 to 128 characters for customers and 12 to 128 for the admin', () => {
    expect(passwordSchema.safeParse('a7Kq-blue-moon').success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(7)).success).toBe(false);
    expect(passwordSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(adminPasswordSchema.safeParse('a7Kq-blue-moo').success).toBe(true);
    expect(adminPasswordSchema.safeParse('a7Kq-blue-m').success).toBe(false);
  });

  it('refuse a common password whatever its case, with its own message', () => {
    expect(isCommonPassword('PassWord1')).toBe(true);
    expect(isCommonPassword('a7Kq-blue-moon')).toBe(false);
    const result = passwordSchema.safeParse('Password1');
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([PASSWORD_TOO_COMMON]);
    expect(adminPasswordSchema.safeParse('BusinessBabe').success).toBe(false);
  });

  it('tell a password equal to the email', () => {
    expect(passwordEqualsEmail(' Sam@Example.com', 'sam@example.com ')).toBe(true);
    expect(passwordEqualsEmail('sam@example.org', 'sam@example.com')).toBe(false);
  });
});

describe('names', () => {
  it('are 2 to 60 characters after trimming, without control characters', () => {
    expect(fullNameSchema.parse('  سارة الأحمد ')).toBe('سارة الأحمد');
    for (const name of ['س', ' a ', 'x'.repeat(61), 'Sam\u0000', 'a\nb']) {
      expect(fullNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
    }
  });
});

describe('phones (rule C6, edge case 14)', () => {
  it('normalize Syrian local and international forms to E.164', () => {
    for (const typed of ['0944 123 456', '+963 944 123 456', '00963944123456', '0944-123-456']) {
      expect(phoneSchema.parse(typed), typed).toBe('+963944123456');
    }
  });

  it('accept other countries in international form', () => {
    expect(phoneSchema.parse('+49 1512 3456789')).toBe('+4915123456789');
  });

  it('refuse invalid numbers', () => {
    for (const typed of ['', '123', '0944', 'not a phone', '+963 11', '+1 555']) {
      expect(phoneSchema.safeParse(typed).success, typed).toBe(false);
    }
  });
});

describe('customer forms', () => {
  const signUp = {
    name: 'سارة الأحمد',
    email: 'sara@example.com',
    password: 'a7Kq-blue-moon',
    phone: '0944123456',
  };

  it('sign-up needs a name, an email, a password and a phone, and normalizes the phone', () => {
    expect(customerSignUpSchema.parse(signUp)).toEqual({ ...signUp, phone: '+963944123456' });
    expect(customerSignUpSchema.safeParse({ ...signUp, phone: undefined }).success).toBe(false);
  });

  it('refuse a password equal to the email', () => {
    const result = customerSignUpSchema.safeParse({ ...signUp, password: 'Sara@Example.com' });
    expect(result.error?.issues).toMatchObject([
      { path: ['password'], message: PASSWORD_EQUALS_EMAIL },
    ]);
    const reset = { email: signUp.email, otp: '123456' };
    expect(resetPasswordSchema.safeParse({ ...reset, password: signUp.email }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ ...reset, password: signUp.password }).success).toBe(
      true,
    );
  });

  it('profile updates change the name, the phone or both, never nothing', () => {
    expect(updateCustomerProfileSchema.parse({ phone: '0944123456' })).toEqual({
      phone: '+963944123456',
    });
    expect(updateCustomerProfileSchema.safeParse({ name: 'سارة' }).success).toBe(true);
    expect(updateCustomerProfileSchema.safeParse({}).success).toBe(false);
  });

  it('email codes are six digits', () => {
    expect(otpCodeSchema.safeParse('012345').success).toBe(true);
    expect(otpCodeSchema.safeParse('01234').success).toBe(false);
  });
});
