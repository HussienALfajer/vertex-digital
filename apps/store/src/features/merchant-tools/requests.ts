import {
  type AlertSettings,
  type CustomerPrices,
  ERROR_CODES,
  type ErrorCode,
  type MerchantAlertPage,
  type MerchantCertificate,
  type MerchantDashboard,
  type MerchantGames,
  type MerchantPriceList,
  type MerchantTierHistory,
  type MerchantTierSummary,
  type MerchantTierTable,
  type OrderPrint,
  type OrderSale,
  type PinnedGames,
  PRICE_LIST_CURRENCIES,
  PRICE_LIST_MODES,
  type ReceiptSettings,
  type RecentPlayers,
  type ReleasedCodes,
  type SavedPlayerList,
  type SellingPriceInput,
  type SellingPriceRow,
  type SellingPrices,
  type SellingSettings,
  type Statement,
  type StatementMonths,
  type StoreGame,
  type UpdateReceiptSettings,
  type UpdateWatches,
  type UploadedLogo,
  type Watches,
} from '@vertex-digital/contracts';
import { apiRequest, type Failure, type Result } from '@/lib/api';

/*
 * The merchant area (S21 F30–F35). The routes take no customer id: the session cookie says
 * whose area it is. Never cached; a customer who is not a merchant gets `NOT_MERCHANT`.
 */

type Fetcher = typeof fetch;

export function getDashboard(period: 'today' | 'month', fetcher: Fetcher = fetch) {
  return apiRequest<MerchantDashboard>(`/api/merchant/dashboard?period=${period}`, { fetcher });
}

/**
 * S23 OP5: a game for the counter tools: the public read with the packs in early access an
 * eligible merchant's prices carry, or, for a game in early access, its own read.
 */
export async function readCounterGame(slug: string): Promise<Result<StoreGame>> {
  const path = `/api/catalog/games/${encodeURIComponent(slug)}`;
  const [store, own] = await Promise.all([
    apiRequest<StoreGame>(path),
    apiRequest<CustomerPrices>(`${path}/prices`),
  ]);
  const read =
    !store.ok && store.reason === 'NOT_FOUND'
      ? await apiRequest<StoreGame>(`${path}/early-access`)
      : store;
  if (!read.ok || !own.ok) return read;
  const shown = new Set(read.data.products.map((product) => product.id));
  const early = own.data.earlyProducts.filter((product) => !shown.has(product.id));
  return { ok: true, data: { ...read.data, products: [...read.data.products, ...early] } };
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

export function getPinnedGames(fetcher: Fetcher = fetch) {
  return apiRequest<PinnedGames>('/api/merchant/pinned-games', { fetcher });
}

export function savePinnedGames(input: PinnedGames, fetcher: Fetcher = fetch) {
  return apiRequest<PinnedGames>('/api/merchant/pinned-games', {
    method: 'PUT',
    body: input,
    fetcher,
  });
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

type FileResult = { ok: true; blob: Blob; fileName: string } | { ok: false; reason: Failure };

/** CR2: the codes' `.xlsx`, read as a file; null when the API refused (its code in `reason`). */
export function exportCodes(orderId: string, fetcher: Fetcher = fetch): Promise<FileResult> {
  return readFile(
    `/api/orders/${encodeURIComponent(orderId)}/codes/release`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'export' }),
    },
    'codes.xlsx',
    fetcher,
  );
}

/** A file the API answers (an `.xlsx`, a PNG), with its name; a refusal by its code. */
async function readFile(
  path: string,
  init: RequestInit,
  fallbackName: string,
  fetcher: Fetcher,
): Promise<FileResult> {
  try {
    const response = await fetcher(path, { ...init, credentials: 'same-origin' });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: string } | null;
      const known = (ERROR_CODES as readonly string[]).includes(body?.code ?? '');
      return { ok: false, reason: known ? (body?.code as ErrorCode) : 'UNKNOWN' };
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
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

/* Tiers (S23 ID3, ID4, ID7, PG1–PG7) */

export function getTier(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantTierSummary>('/api/merchant/tier', { fetcher });
}

export function getTierTable(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantTierTable>('/api/merchant/tier/table', { fetcher });
}

export function getTierHistory(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantTierHistory>('/api/merchant/tier/history', { fetcher });
}

/** ID4: the celebration was seen. */
export function markCelebrated(fetcher: Fetcher = fetch) {
  return apiRequest<null>('/api/merchant/tier/celebrated', { method: 'POST', fetcher });
}

export function getCertificate(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantCertificate>('/api/merchant/certificate', { fetcher });
}

/** ID7: a new code; old prints stop resolving. 3 a day. */
export function reissueCertificate(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantCertificate>('/api/merchant/certificate/reissue', {
    method: 'POST',
    fetcher,
  });
}

/** The merchant's own logo, for the receipt preview and the printed receipt. */
export const logoPath = (fileId: string) => `/api/merchant/logo/${encodeURIComponent(fileId)}`;

/* Documents (S21 F36, F38, PR 3) */

export interface PriceListOptions {
  /** Empty: the followed games, else all (PL1). */
  gameIds: string[];
  mode: MerchantPriceList['mode'];
  currency: MerchantPriceList['currency'];
  unavailable: boolean;
}

/** The query of the price list and its image, in the same order everywhere. */
export function priceListQuery(options: PriceListOptions, page?: number): string {
  const query = new URLSearchParams();
  if (options.gameIds.length > 0) query.set('gameIds', options.gameIds.join(','));
  query.set('mode', options.mode);
  query.set('currency', options.currency);
  query.set('unavailable', String(options.unavailable));
  if (page !== undefined) query.set('page', String(page));
  return query.toString();
}

const oneOf = <Value extends string>(
  values: readonly Value[],
  value: string | null,
  fallback: Value,
) => (values.includes(value as Value) ? (value as Value) : fallback);

/** The options `priceListQuery` wrote, read back from an address (the print page and its back). */
export function priceListOptionsFrom(search: URLSearchParams): PriceListOptions {
  return {
    gameIds: (search.get('gameIds') ?? '').split(',').filter((id) => id.length > 0),
    mode: oneOf<MerchantPriceList['mode']>(PRICE_LIST_MODES, search.get('mode'), 'selling'),
    currency: oneOf<MerchantPriceList['currency']>(
      PRICE_LIST_CURRENCIES,
      search.get('currency'),
      'syp',
    ),
    unavailable: search.get('unavailable') === 'true',
  };
}

export function getPriceList(options: PriceListOptions, fetcher: Fetcher = fetch) {
  return apiRequest<MerchantPriceList>(`/api/merchant/price-list?${priceListQuery(options)}`, {
    fetcher,
  });
}

/** PL3: one image of the list, 60 packs a page. */
export function priceListImage(options: PriceListOptions, page: number, fetcher: Fetcher = fetch) {
  return readFile(
    `/api/merchant/price-list.png?${priceListQuery(options, page)}`,
    {},
    `price-list-${page}.png`,
    fetcher,
  );
}

export function getStatements(fetcher: Fetcher = fetch) {
  return apiRequest<StatementMonths>('/api/merchant/statements', { fetcher });
}

export function getStatement(month: string, fetcher: Fetcher = fetch) {
  return apiRequest<Statement>(`/api/merchant/statements/${encodeURIComponent(month)}`, {
    fetcher,
  });
}

/** ST3: the month's `.xlsx`. */
export function exportStatement(month: string, fetcher: Fetcher = fetch) {
  return readFile(
    `/api/merchant/statements/${encodeURIComponent(month)}/export`,
    {},
    `statement-${month}.xlsx`,
    fetcher,
  );
}
