import type { SavedPlayer, SavedPlayerList } from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's saved player IDs (S10 rules SP3, SP5): the list, a new label, and a delete. The
 * routes take no customer id: the session cookie says whose IDs they are, and another customer's
 * ID answers `NOT_FOUND`. IDs are saved only inside a purchase (rule SP1). Never cached.
 */

type Fetcher = typeof fetch;

/** Newest used first, at most 50; `gameId` keeps one game's. */
export function listSavedPlayers(gameId?: string, fetcher: Fetcher = fetch) {
  const query = gameId ? `?${new URLSearchParams({ gameId })}` : '';
  return apiRequest<SavedPlayerList>(`/api/saved-players${query}`, { fetcher });
}

export function renameSavedPlayer(id: string, label: string, fetcher: Fetcher = fetch) {
  return apiRequest<SavedPlayer>(`/api/saved-players/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { label },
    fetcher,
  });
}

export function deleteSavedPlayer(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<null>(`/api/saved-players/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fetcher,
  });
}
