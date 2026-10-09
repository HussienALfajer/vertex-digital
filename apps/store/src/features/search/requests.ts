import type { SearchIndex } from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/**
 * Rule SR2: every shown game and its products, public and cached by the browser for 30 seconds.
 * Read once, when the search opens for the first time.
 */
export function getSearchIndex(fetcher: typeof fetch = fetch) {
  return apiRequest<SearchIndex>('/api/catalog/search-index', { fetcher });
}
