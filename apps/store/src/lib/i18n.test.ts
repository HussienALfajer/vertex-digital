import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import { t } from './i18n';

describe('t', () => {
  it('reads a nested key', () => {
    expect(t('signIn.title')).toBe(ar.signIn.title);
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(t('footer.rights', { year: 2026 })).toBe('© 2026 Vertex Digital');
    expect(t('footer.rights')).toBe('© {year} Vertex Digital');
  });
});

describe('the Arabic catalog', () => {
  const strings = (node: unknown): string[] =>
    typeof node === 'string' ? [node] : Object.values(node as object).flatMap(strings);

  it('has no empty strings and no exclamation marks in system text (identity §10)', () => {
    for (const text of strings(ar)) {
      expect(text.trim()).not.toBe('');
      expect(text).not.toMatch(/[!！]/);
    }
  });

  it('uses Latin digits only', () => {
    for (const text of strings(ar)) expect(text).not.toMatch(/[٠-٩۰-۹]/);
  });
});
