import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteServerDate, serverNow } from './server-clock';

const NOW = Date.parse('2026-10-15T12:00:00Z');

/** An answer's headers: `Date` at `at`, never stored unless `cacheControl` says otherwise. */
function answer(at: number | string | null, cacheControl = 'no-store'): Headers {
  const headers = new Headers({ 'cache-control': cacheControl });
  if (at !== null) headers.set('date', typeof at === 'string' ? at : new Date(at).toUTCString());
  return headers;
}

afterEach(() => {
  noteServerDate(answer(NOW), NOW, NOW);
  vi.useRealTimers();
});

describe('serverNow', () => {
  it('follows a server clock minutes away from the device', () => {
    vi.useFakeTimers({ now: NOW });
    noteServerDate(answer(NOW + 10 * 60_000), NOW - 200, NOW);
    expect(Math.abs(serverNow() - (NOW + 10 * 60_000 + 600))).toBeLessThan(1);
  });

  it('keeps the device clock within the header precision', () => {
    vi.useFakeTimers({ now: NOW });
    noteServerDate(answer(NOW - 1_000), NOW, NOW);
    expect(serverNow()).toBe(NOW);
  });

  it('ignores a missing or unreadable header', () => {
    vi.useFakeTimers({ now: NOW });
    noteServerDate(answer(NOW + 60_000), NOW, NOW);
    const learned = serverNow();
    noteServerDate(answer(null), NOW, NOW);
    noteServerDate(answer('not a date'), NOW, NOW);
    expect(serverNow()).toBe(learned);
  });

  it('ignores a cacheable answer, whose Date may be minutes old', () => {
    vi.useFakeTimers({ now: NOW });
    noteServerDate(answer(NOW - 4 * 60_000, 'public, max-age=300'), NOW, NOW);
    noteServerDate(answer(NOW - 4 * 60_000, ''), NOW, NOW);
    expect(serverNow()).toBe(NOW);
  });
});
