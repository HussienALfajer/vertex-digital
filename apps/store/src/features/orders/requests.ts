import type { Order, OrderPage, RevealedCode } from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's own orders (S08): the list, one order, and a code's reveal. The routes take no
 * customer id: the session cookie says whose orders they are, and another customer's order
 * answers `NOT_FOUND`. Never cached.
 */

type Fetcher = typeof fetch;

/** One page of "طلباتي", newest first; `cursor` from the previous page. */
export function listOrders(cursor?: string, fetcher: Fetcher = fetch) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return apiRequest<OrderPage>(`/api/orders${query}`, { fetcher });
}

export function getOrder(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Order>(`/api/orders/${encodeURIComponent(id)}`, { fetcher });
}

/** Rule C2: the code's value, and when it was first revealed; each call is logged. */
export function revealCode(orderId: string, codeId: string, fetcher: Fetcher = fetch) {
  return apiRequest<RevealedCode>(
    `/api/orders/${encodeURIComponent(orderId)}/codes/${encodeURIComponent(codeId)}/reveal`,
    { method: 'POST', fetcher },
  );
}
