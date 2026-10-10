import type {
  Order,
  OrderPage,
  ReceiptOptions,
  RevealedCode,
  ShareLink,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's own orders (S08): the list, one order, and a code's reveal. The routes take no
 * customer id: the session cookie says whose orders they are, and another customer's order
 * answers `NOT_FOUND`. Never cached.
 */

type Fetcher = typeof fetch;

/**
 * One page of "طلباتي", newest first; `cursor` from the previous page. With `checkout`, that
 * checkout's orders in line order with the checkout itself (S10 rule CT6).
 */
export function listOrders(cursor?: string, fetcher: Fetcher = fetch, checkout?: string) {
  const params = new URLSearchParams({
    ...(cursor && { cursor }),
    ...(checkout && { checkout }),
  });
  const query = params.size > 0 ? `?${params}` : '';
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

/** Rule RS8: cancels an own reservation; any other status answers `ORDER_NOT_CANCELLABLE`. */
export function cancelOrder(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Order>(`/api/orders/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    fetcher,
  });
}

/** S10 rule RC1: creates the receipt link, or changes the live one's choices (same token). */
export function saveReceiptLink(id: string, options: ReceiptOptions, fetcher: Fetcher = fetch) {
  return apiRequest<ShareLink>(`/api/orders/${encodeURIComponent(id)}/receipt-link`, {
    method: 'PUT',
    body: options,
    fetcher,
  });
}

/** S10 rule GF4: a new gift link after the last one was revoked. */
export function createGiftLink(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShareLink>(`/api/orders/${encodeURIComponent(id)}/gift-link`, {
    method: 'POST',
    fetcher,
  });
}

/** S10 rules GF4, RC3: the link's page then answers not found; this cannot be undone. */
export function revokeShareLink(id: string, linkId: string, fetcher: Fetcher = fetch) {
  return apiRequest<null>(
    `/api/orders/${encodeURIComponent(id)}/share-links/${encodeURIComponent(linkId)}/revoke`,
    { method: 'POST', fetcher },
  );
}
