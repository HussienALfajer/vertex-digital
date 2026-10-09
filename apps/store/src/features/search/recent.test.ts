import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRecentSearches, readRecentSearches, rememberSearch } from './recent';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('recent searches (rule SR5)', () => {
  it('keeps the last 5, newest first, each once', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    for (const query of ['ببجي', 'pubg', 'فري فاير', '60', 'itunes', 'ببجي', ' razer '])
      rememberSearch(query);
    expect(readRecentSearches()).toEqual(['razer', 'ببجي', 'itunes', '60', 'فري فاير']);
    rememberSearch('   ');
    expect(readRecentSearches()).toHaveLength(5);
    clearRecentSearches();
    expect(readRecentSearches()).toEqual([]);
  });

  it('ignores what it cannot read', () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    storage.setItem('vd:recent-searches', '{not json');
    expect(readRecentSearches()).toEqual([]);
    storage.setItem('vd:recent-searches', JSON.stringify(['a', 3, 'b']));
    expect(readRecentSearches()).toEqual(['a', 'b']);
  });

  it('works without storage when it throws (private mode)', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    });
    expect(readRecentSearches()).toEqual([]);
    expect(rememberSearch('pubg')).toEqual(['pubg']);
    expect(() => clearRecentSearches()).not.toThrow();
  });

  it('survives a storage that refuses writes', () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    storage.removeItem = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('window', { localStorage: storage });
    expect(rememberSearch('pubg')).toEqual(['pubg']);
    expect(() => clearRecentSearches()).not.toThrow();
  });
});
