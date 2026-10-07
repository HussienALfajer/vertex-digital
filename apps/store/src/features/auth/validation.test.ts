import { describe, expect, it } from 'vitest';
import { t } from '@/lib/i18n';
import { codeError, emailError, nameError, newPasswordError } from './validation';

describe('field messages', () => {
  it('explains each refused email', () => {
    expect(emailError('')).toBe(t('validation.emailRequired'));
    expect(emailError('not-an-email')).toBe(t('validation.emailInvalid'));
    expect(emailError('a@example.com')).toBeUndefined();
  });

  it.each([
    ['', 'validation.passwordRequired'],
    ['short', 'validation.passwordShort'],
    ['x'.repeat(129), 'validation.passwordLong'],
    ['PassWord1', 'validation.passwordCommon'],
    ['A@Example.com', 'validation.passwordEqualsEmail'],
  ] as const)('refuses the new password %j with %s', (password, key) => {
    expect(newPasswordError(password, 'a@example.com')).toBe(t(key));
  });

  it('accepts a long uncommon password', () => {
    expect(newPasswordError('a7Kq-blue-moon-river', 'a@example.com')).toBeUndefined();
  });

  it('checks names and codes with the contract', () => {
    expect(nameError(' س ')).toBe(t('validation.nameRequired'));
    expect(nameError('سارة الأحمد')).toBeUndefined();
    expect(codeError('12345')).toBe(t('validation.codeInvalid'));
    expect(codeError('123456')).toBeUndefined();
  });
});
