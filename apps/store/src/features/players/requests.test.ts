import { describe, expect, it } from 'vitest';
import { deleteSavedPlayer, listSavedPlayers, renameSavedPlayer } from './requests';

function fetcher(status: number, body: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null });
    return new Response(body === null ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const GAME = '0199e000-0000-7000-8000-0000000000b1';

describe('saved player IDs (rules SP3, SP5)', () => {
  it('lists all of them, or one game’s', async () => {
    const { fetch, calls } = fetcher(200, { items: [] });
    await expect(listSavedPlayers(undefined, fetch)).resolves.toEqual({
      ok: true,
      data: { items: [] },
    });
    await listSavedPlayers(GAME, fetch);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/saved-players',
      `/api/saved-players?gameId=${GAME}`,
    ]);
  });

  it('renames one and deletes one', async () => {
    const renamed = fetcher(200, { id: 'p1', label: 'أخي' });
    await renameSavedPlayer('p1', 'أخي', renamed.fetch);
    expect(renamed.calls).toEqual([
      { url: '/api/saved-players/p1', method: 'PATCH', body: JSON.stringify({ label: 'أخي' }) },
    ]);
    const deleted = fetcher(204, null);
    await expect(deleteSavedPlayer('p1', deleted.fetch)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(deleted.calls[0]?.method).toBe('DELETE');
    const missing = fetcher(404, { code: 'NOT_FOUND' });
    await expect(deleteSavedPlayer('p2', missing.fetch)).resolves.toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });
});
