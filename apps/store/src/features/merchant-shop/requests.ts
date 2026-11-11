import type {
  MerchantShop,
  MerchantShopOrderPage,
  MerchantShopState,
  MerchantShopTicket,
  MerchantShopTicketSummary,
  RequestShop,
  ReturnRequest,
  ShopCustomerPage,
  ShopCustomerRow,
  ShopSettings,
  ShopStats,
  ShopTransfer,
  ShopTransferResult,
} from '@vertex-digital/contracts';
import { apiRequest, type Failure, type Result } from '@/lib/api';

/*
 * "متجري" (S26 PR 4): the merchant's shop routes under `/api/merchant/shop`. The session cookie
 * says whose shop; never cached. Money routes take the caller's `Idempotency-Key`.
 */

type Fetcher = typeof fetch;

const BASE = '/api/merchant/shop';

export function getShop(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantShopState>(BASE, { fetcher });
}

export function slugAvailable(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest<{ available: boolean }>(
    `${BASE}/slug-available?slug=${encodeURIComponent(slug)}`,
    { fetcher },
  );
}

export function requestShop(input: RequestShop, key: string, fetcher: Fetcher = fetch) {
  return apiRequest<MerchantShop>(BASE, {
    method: 'POST',
    body: input,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

export function saveShopSettings(input: ShopSettings, fetcher: Fetcher = fetch) {
  return apiRequest<MerchantShop>(BASE, { method: 'PATCH', body: input, fetcher });
}

export function getHiddenGames(fetcher: Fetcher = fetch) {
  return apiRequest<{ gameIds: string[] }>(`${BASE}/hidden-games`, { fetcher });
}

export function saveHiddenGames(gameIds: string[], fetcher: Fetcher = fetch) {
  return apiRequest<{ gameIds: string[] }>(`${BASE}/hidden-games`, {
    method: 'PUT',
    body: { gameIds },
    fetcher,
  });
}

export function listCustomers(
  query: { q?: string; cursor?: string | null },
  fetcher: Fetcher = fetch,
) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  const search = params.toString();
  return apiRequest<ShopCustomerPage>(`${BASE}/customers${search ? `?${search}` : ''}`, {
    fetcher,
  });
}

export function createCustomer(
  input: { name: string; email: string; phone: string },
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopCustomerRow>(`${BASE}/customers`, {
    method: 'POST',
    body: input,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

export function updateCustomer(
  id: string,
  input: { name?: string; phone?: string },
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ShopCustomerRow>(`${BASE}/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    fetcher,
  });
}

export function inviteAgain(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<null>(`${BASE}/customers/${encodeURIComponent(id)}/invite`, {
    method: 'POST',
    fetcher,
  });
}

export function transferCheck(password: string, fetcher: Fetcher = fetch) {
  return apiRequest<{ checkedUntil: string }>(`${BASE}/transfer-check`, {
    method: 'POST',
    body: { password },
    fetcher,
  });
}

export function transfer(id: string, input: ShopTransfer, key: string, fetcher: Fetcher = fetch) {
  return apiRequest<ShopTransferResult>(`${BASE}/customers/${encodeURIComponent(id)}/transfers`, {
    method: 'POST',
    body: input,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

export function requestReturn(
  id: string,
  amountUsdUnits: number,
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ReturnRequest>(`${BASE}/customers/${encodeURIComponent(id)}/return-requests`, {
    method: 'POST',
    body: { amountUsdUnits },
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

export function cancelReturn(id: string, requestId: string, fetcher: Fetcher = fetch) {
  return apiRequest<ReturnRequest>(
    `${BASE}/customers/${encodeURIComponent(id)}/return-requests/${encodeURIComponent(requestId)}`,
    { method: 'DELETE', fetcher },
  );
}

export function listShopOrders(
  query: { customerId?: string | null; cursor?: string | null },
  fetcher: Fetcher = fetch,
) {
  const params = new URLSearchParams();
  if (query.customerId) params.set('customerId', query.customerId);
  if (query.cursor) params.set('cursor', query.cursor);
  const search = params.toString();
  return apiRequest<MerchantShopOrderPage>(`${BASE}/orders${search ? `?${search}` : ''}`, {
    fetcher,
  });
}

export type MerchantTicketPage = { items: MerchantShopTicketSummary[]; nextCursor: string | null };

export function listShopTickets(cursor: string | null, fetcher: Fetcher = fetch) {
  return apiRequest<MerchantTicketPage>(
    `${BASE}/tickets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { fetcher },
  );
}

export function getShopTicket(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<MerchantShopTicket>(`${BASE}/tickets/${encodeURIComponent(id)}`, { fetcher });
}

export function shopTicketAttachmentUrl(ticketId: string, fileId: string): string {
  return `${BASE}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(fileId)}`;
}

export function replyToShopTicket(
  id: string,
  body: string,
  files: Blob[],
  key: string,
  fetcher: Fetcher = fetch,
) {
  const form = new FormData();
  form.append('body', body);
  for (const file of files) form.append('files', file);
  return apiRequest<MerchantShopTicket>(`${BASE}/tickets/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: form,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

export function escalateShopTicket(id: string, note: string, fetcher: Fetcher = fetch) {
  return apiRequest<MerchantShopTicket>(`${BASE}/tickets/${encodeURIComponent(id)}/escalate`, {
    method: 'POST',
    body: { note },
    fetcher,
  });
}

export function getShopStats(period: ShopStats['period'], fetcher: Fetcher = fetch) {
  return apiRequest<ShopStats>(`${BASE}/stats?period=${period}`, { fetcher });
}

export const STICKER_SIZES = ['a6', '80mm'] as const;

/** SP2: the sticker as a file (20 an hour), or why it could not come. */
export async function stickerFile(
  size: (typeof STICKER_SIZES)[number],
  fetcher: Fetcher = fetch,
): Promise<{ ok: true; blob: Blob; fileName: string } | { ok: false; reason: Failure }> {
  let response: Response;
  try {
    response = await fetcher(`${BASE}/sticker.png?size=${size}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
  if (response.ok) return { ok: true, blob: await response.blob(), fileName: `shop-${size}.png` };
  const failed: Result<unknown> = await apiFailure(response);
  return { ok: false, reason: failed.ok ? 'UNKNOWN' : failed.reason };
}

async function apiFailure(response: Response): Promise<Result<unknown>> {
  if (response.status === 429) return { ok: false, reason: 'RATE_LIMITED' };
  if (response.status === 401) return { ok: false, reason: 'UNAUTHORIZED' };
  return { ok: false, reason: 'UNKNOWN' };
}
