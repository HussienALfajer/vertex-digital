import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPendingEmail, savePendingEmail } from './pending-email';

/* The address waiting for its code and where the customer goes after it (rules C7; A01-18). */

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  vi.stubGlobal('window', { location: { origin: 'https://digital.vertexmedia.pro' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the pending email', () => {
  it('keeps a same-origin destination', () => {
    savePendingEmail({ email: 'a@example.test', next: '/cart?line=1' });
    expect(readPendingEmail()).toEqual({ email: 'a@example.test', next: '/cart?line=1' });
  });

  it('checks the destination again on read: storage written by anything else goes home (A01-18)', () => {
    for (const next of ['//evil.example', 'https://evil.example/x', '/\n/evil.example', 42]) {
      sessionStorage.setItem(
        'vertex-pending-email',
        JSON.stringify({ email: 'a@example.test', next }),
      );
      expect(readPendingEmail()).toEqual({ email: 'a@example.test', next: '/' });
    }
  });
});
