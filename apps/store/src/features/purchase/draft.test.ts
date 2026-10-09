import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, readDraft, saveDraft } from './draft';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('buy box draft (rule BB3)', () => {
  it('restores the fields for the same game and pack only', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    saveDraft({ gameSlug: 'pubg', packId: 'p1', quantity: 2, fields: { player_id: '5123' } });
    expect(readDraft('pubg', 'p1')).toEqual({
      gameSlug: 'pubg',
      packId: 'p1',
      quantity: 2,
      fields: { player_id: '5123' },
    });
    expect(readDraft('pubg', 'p2')).toBeNull();
    expect(readDraft('free-fire', 'p1')).toBeNull();
    clearDraft();
    expect(readDraft('pubg', 'p1')).toBeNull();
  });

  it('drops what it cannot read', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    storage.setItem(
      'vd:buy-draft',
      JSON.stringify({ gameSlug: 'pubg', packId: 'p1', quantity: 'x', fields: { a: 1, b: 'b' } }),
    );
    expect(readDraft('pubg', 'p1')).toEqual({
      gameSlug: 'pubg',
      packId: 'p1',
      quantity: 1,
      fields: { b: 'b' },
    });
    storage.setItem('vd:buy-draft', '{broken');
    expect(readDraft('pubg', 'p1')).toBeNull();
  });

  it('works without storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(() =>
      saveDraft({ gameSlug: 'pubg', packId: 'p1', quantity: 1, fields: {} }),
    ).not.toThrow();
    expect(readDraft('pubg', 'p1')).toBeNull();
    expect(() => clearDraft()).not.toThrow();
  });
});
