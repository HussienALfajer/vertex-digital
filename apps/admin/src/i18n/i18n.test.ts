import { describe, expect, it } from 'vitest';
import i18n from './index';
import ar from './locales/ar.json';

describe('i18n', () => {
  it('runs in Arabic, right to left', () => {
    expect(i18n.language).toBe('ar');
    expect(i18n.dir()).toBe('rtl');
  });

  it('interpolates values into Arabic strings', () => {
    expect(i18n.t('twoFactorSetup.stepOf', { step: 1, total: 3 })).toBe('الخطوة 1 من 3');
  });
});

describe('the Arabic catalog', () => {
  const strings = (node: unknown): string[] =>
    typeof node === 'string' ? [node] : Object.values(node as object).flatMap(strings);

  it('has no exclamation marks in system text and Latin digits only (identity §10)', () => {
    for (const text of strings(ar)) {
      expect(text).not.toMatch(/[!！]/);
      expect(text).not.toMatch(/[٠-٩۰-۹]/);
    }
  });
});
