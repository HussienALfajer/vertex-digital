import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptKey, clearAttempt } from './attempt';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('attemptKey (rule BB6)', () => {
  it('reuses the key for the same body across remounts, a new one for another body', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    const first = attemptKey('p1', '{"a":1}');
    expect(attemptKey('p1', '{"a":1}')).toBe(first);
    const other = attemptKey('p1', '{"a":2}');
    expect(other).not.toBe(first);
    expect(attemptKey('p2', '{"a":2}')).not.toBe(other);
    clearAttempt('p1');
    expect(attemptKey('p1', '{"a":2}')).not.toBe(other);
  });

  it('keeps the key in memory when storage is blocked', () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const key = attemptKey('p3', 'body');
    expect(attemptKey('p3', 'body')).toBe(key);
    expect(() => clearAttempt('p3')).not.toThrow();
  });
});
