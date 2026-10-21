import type {
  AlertSettings,
  MerchantAlertPage,
  MerchantDashboard,
  MerchantGames,
  SellingPriceInput,
  SellingPriceRow,
  SellingPrices,
  SellingSettings,
  UpdateWatches,
  Watches,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The merchant area (S21 F30, F31, F37). The routes take no customer id: the session cookie says
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
