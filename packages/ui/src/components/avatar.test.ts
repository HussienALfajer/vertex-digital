import { describe, expect, it } from 'vitest';
import { initialsOf } from './avatar';

describe('initialsOf', () => {
  it('takes the first letters of two words, skipping the Arabic article', () => {
    expect(initialsOf('سارة الخطيب')).toBe('س خ');
    expect(initialsOf('ليان الأحمد الثالث')).toBe('ل أ');
  });

  it('keeps Latin initials together', () => {
    expect(initialsOf('Omar Haddad')).toBe('OH');
    expect(initialsOf('  Omar  ')).toBe('O');
  });
});
