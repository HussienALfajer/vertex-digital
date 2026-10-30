import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFormDraft, forgetFormDrafts, readFormDraft, saveFormDraft } from './form-draft';

function fakeStorage() {
  // Own keys, as `Object.keys(sessionStorage)` lists a browser's.
  const store: Record<string, string> = {};
  Object.defineProperties(store, {
    getItem: { value: (key: string) => store[key] ?? null },
    setItem: {
      value: (key: string, value: string) => {
        store[key] = value;
      },
    },
    removeItem: {
      value: (key: string) => {
        delete store[key];
      },
    },
  });
  return store;
}

describe('form drafts', () => {
  beforeEach(() => vi.stubGlobal('sessionStorage', fakeStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a draft until it is cleared', () => {
    saveFormDraft('ticket', { subject: 'x' });
    expect(readFormDraft('ticket')).toEqual({ subject: 'x' });
    clearFormDraft('ticket');
    expect(readFormDraft('ticket')).toBeNull();
  });

  it('forgets only its own keys when the session ends', () => {
    saveFormDraft('ticket', { subject: 'x' });
    saveFormDraft('merchant', { tradeName: 'y' });
    sessionStorage.setItem('vd:order-attempt:p1', '{}');
    forgetFormDrafts();
    expect(readFormDraft('ticket')).toBeNull();
    expect(readFormDraft('merchant')).toBeNull();
    expect(sessionStorage.getItem('vd:order-attempt:p1')).toBe('{}');
  });

  it('degrades without storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    });
    saveFormDraft('ticket', {});
    clearFormDraft('ticket');
    expect(readFormDraft('ticket')).toBeNull();
  });
});
