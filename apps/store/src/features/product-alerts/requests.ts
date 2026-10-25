import type { ProductAlert, ProductAlertKind, ProductAlertList } from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's availability and price-drop alerts (S22 PA1, PA6, PA7). The routes take no
 * customer id: the session cookie says whose alerts they are, and another customer's alert
 * answers `NOT_FOUND`. The price-drop baseline is the server's price, never sent. Never cached.
 */

type Fetcher = typeof fetch;

/** A game's active alerts (its page), or "تنبيهاتي"'s active or newest ended ones. */
export function listProductAlerts(
  query: { gameId?: string; status?: 'active' | 'ended' } = {},
  fetcher: Fetcher = fetch,
) {
  const params = new URLSearchParams({
    ...(query.gameId && { gameId: query.gameId }),
    ...(query.status && { status: query.status }),
  });
  const search = params.size > 0 ? `?${params}` : '';
  return apiRequest<ProductAlertList>(`/api/product-alerts${search}`, { fetcher });
}

/** PA1: an active alert of the same kind answers as it is. */
export function createProductAlert(
  productId: string,
  kind: ProductAlertKind,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ProductAlert>('/api/product-alerts', {
    method: 'POST',
    body: { productId, kind },
    fetcher,
  });
}

export function cancelProductAlert(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<null>(`/api/product-alerts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fetcher,
  });
}
