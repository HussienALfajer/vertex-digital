import {
  type AlertSettings,
  type BulkCheckRequest,
  type BulkCheckResult,
  type CustomerPrices,
  ERROR_CODES,
  type ErrorCode,
  type MerchantAlertPage,
  type MerchantDashboard,
  type MerchantGames,
  type OrderPrint,
  type OrderSale,
  type ReceiptSettings,
  type RecentPlayers,
  type ReleasedCodes,
  type SavedPlayerList,
  type SellingPriceInput,
  type SellingPriceRow,
  type SellingPrices,
  type SellingSettings,
  type UpdateReceiptSettings,
  type UpdateWatches,
  type UploadedLogo,
  type Watches,
} from '@vertex-digital/contracts';
import { apiRequest, type Failure } from '@/lib/api';

/*
 * The merchant area (S21 F30–F35). The routes take no customer id: the session cookie says
 * whose area it is. Never cached; a customer who is not a merchant gets `NOT_MERCHANT`.
 */

type Fetcher = typeof fetch;

export function getDashboard(period: 'today' | 'month', fetcher: Fetcher = fetch) {
  return apiRequest<MerchantDashboard>(`/api/merchant/dashboard?period=${period}`, { fetcher });
}

export function getMerchantGames(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantGames>('/api/merchant/games', { fetcher });
}

export function getSellingSettings(fetcher: Fetcher = fetch) {
  return apiRequest<SellingSettings>('/api/merchant/selling-settings', { fetcher });
}

export function saveSellingSettings(input: SellingSettings, fetcher: Fetcher = fetch) {
  return apiRequest<SellingSettings>('/api/merchant/selling-settings', {
    method: 'PUT',
    body: input,
    fetcher,
  });
}

export function getSellingPrices(gameId: string, fetcher: Fetcher = fetch) {
  return apiRequest<SellingPrices>(
    `/api/merchant/selling-prices?gameId=${encodeURIComponent(gameId)}`,
    { fetcher },
  );
}

export function setSellingPrice(
  productId: string,
  input: SellingPriceInput,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<SellingPriceRow>(
    `/api/merchant/selling-prices/${encodeURIComponent(productId)}`,
    { method: 'PUT', body: input, fetcher },
  );
}

export function clearSellingPrice(productId: string, fetcher: Fetcher = fetch) {
  return apiRequest<SellingPriceRow>(
    `/api/merchant/selling-prices/${encodeURIComponent(productId)}`,
    { method: 'DELETE', fetcher },
  );
}

export function getWatches(fetcher: Fetcher = fetch) {
  return apiRequest<Watches>('/api/merchant/watches', { fetcher });
}

export function saveWatches(input: UpdateWatches, fetcher: Fetcher = fetch) {
  return apiRequest<Watches>('/api/merchant/watches', { method: 'PUT', body: input, fetcher });
}

export function getAlerts(cursor: string | null, fetcher: Fetcher = fetch) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<MerchantAlertPage>(`/api/merchant/alerts${query}`, { fetcher });
}

export function getAlertSettings(fetcher: Fetcher = fetch) {
  return apiRequest<AlertSettings>('/api/merchant/alert-settings', { fetcher });
}

export function saveAlertSettings(input: AlertSettings, fetcher: Fetcher = fetch) {
  return apiRequest<AlertSettings>('/api/merchant/alert-settings', {
    method: 'PUT',
    body: input,
    fetcher,
  });
}

/* Counter tools (S21 F32–F35, PR 2) */

export function getRecentPlayers(gameId: string, fetcher: Fetcher = fetch) {
  return apiRequest<RecentPlayers>(
    `/api/merchant/recent-players?gameId=${encodeURIComponent(gameId)}`,
    { fetcher },
  );
}

export function getSavedPlayers(gameId: string, fetcher: Fetcher = fetch) {
  return apiRequest<SavedPlayerList>(`/api/saved-players?gameId=${encodeURIComponent(gameId)}`, {
    fetcher,
  });
}

export function getGamePrices(slug: string, fetcher: Fetcher = fetch) {
  return apiRequest<CustomerPrices>(`/api/catalog/games/${encodeURIComponent(slug)}/prices`, {
    fetcher,
  });
}

export function checkBulk(input: BulkCheckRequest, fetcher: Fetcher = fetch) {
  return apiRequest<BulkCheckResult>('/api/merchant/bulk/check', {
    method: 'POST',
    body: input,
    fetcher,
  });
}

export function setOrderSale(orderId: string, input: SellingPriceInput, fetcher: Fetcher = fetch) {
  return apiRequest<OrderSale>(`/api/orders/${encodeURIComponent(orderId)}/sale`, {
    method: 'PUT',
    body: input,
    fetcher,
  });
}

export function releaseCodes(
  orderId: string,
  input: { purpose: 'print' | 'copy'; codeIds?: string[] },
  fetcher: Fetcher = fetch,
) {
  return apiRequest<ReleasedCodes>(`/api/orders/${encodeURIComponent(orderId)}/codes/release`, {
    method: 'POST',
    body: input,
    fetcher,
  });
}

/** CR2: the codes' `.xlsx`, read as a file; null when the API refused (its code in `reason`). */
export async function exportCodes(
  orderId: string,
  fetcher: Fetcher = fetch,
): Promise<{ ok: true; blob: Blob; fileName: string } | { ok: false; reason: Failure }> {
  try {
    const response = await fetcher(`/api/orders/${encodeURIComponent(orderId)}/codes/release`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'export' }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      const known = (ERROR_CODES as readonly string[]).includes(body?.code ?? '');
      return { ok: false, reason: known ? (body?.code as ErrorCode) : 'UNKNOWN' };
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'codes.xlsx';
    return { ok: true, blob: await response.blob(), fileName };
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
}

export function getOrderPrint(orderId: string, fetcher: Fetcher = fetch) {
  return apiRequest<OrderPrint>(`/api/orders/${encodeURIComponent(orderId)}/print`, { fetcher });
}

export function getReceiptSettings(fetcher: Fetcher = fetch) {
  return apiRequest<ReceiptSettings>('/api/merchant/receipt-settings', { fetcher });
}

export function saveReceiptSettings(input: UpdateReceiptSettings, fetcher: Fetcher = fetch) {
  return apiRequest<ReceiptSettings>('/api/merchant/receipt-settings', {
    method: 'PUT',
    body: input,
    fetcher,
  });
}

export function uploadLogo(file: File, fetcher: Fetcher = fetch) {
  const body = new FormData();
  body.append('file', file);
  return apiRequest<UploadedLogo>('/api/merchant/logo', { method: 'POST', body, fetcher });
}

/** The merchant's own logo, for the receipt preview and the printed receipt. */
export const logoPath = (fileId: string) => `/api/merchant/logo/${encodeURIComponent(fileId)}`;
