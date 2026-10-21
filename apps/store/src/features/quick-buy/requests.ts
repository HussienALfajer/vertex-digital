import type { QuickBuy } from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/** "اشحن مجدداً" (S22 QB2): the cards, read in the browser with the session, never cached. */
export function getQuickBuy(fetcher: typeof fetch = fetch) {
  return apiRequest<QuickBuy>('/api/quick-buy', { fetcher });
}
