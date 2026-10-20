import type {
  MerchantApplication,
  MerchantApplicationInput,
  MerchantApplicationState,
  MerchantPhoto,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's merchant application and terms (S20 F28). The routes take no customer id: the
 * session cookie says whose application it is. Never cached.
 */

type Fetcher = typeof fetch;

/** The latest application, whether a new one may be sent, and the terms in force (MA1, MT1). */
export function getMerchantApplication(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantApplicationState>('/api/merchant/application', { fetcher });
}

/** MA2: `key` is the attempt's `Idempotency-Key`; the same key returns the first application. */
export function submitMerchantApplication(
  input: MerchantApplicationInput,
  key: string,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<MerchantApplication>('/api/merchant/application', {
    method: 'POST',
    body: input,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}

/** MA4: the edited form of an application waiting for information. */
export function resubmitMerchantApplication(
  input: MerchantApplicationInput,
  fetcher: Fetcher = fetch,
) {
  return apiRequest<MerchantApplication>('/api/merchant/application', {
    method: 'PUT',
    body: input,
    fetcher,
  });
}

export function withdrawMerchantApplication(fetcher: Fetcher = fetch) {
  return apiRequest<MerchantApplication>('/api/merchant/application/withdraw', {
    method: 'POST',
    fetcher,
  });
}

/** MA3: one image, re-encoded by the API; the answer's id goes into the form. */
export function uploadShopPhoto(file: Blob, fetcher: Fetcher = fetch) {
  const body = new FormData();
  body.append('file', file);
  return apiRequest<MerchantPhoto>('/api/merchant/application/photo', {
    method: 'POST',
    body,
    fetcher,
  });
}

/** Where a shop photo is served, to the customer who uploaded it only. */
export function shopPhotoUrl(fileId: string): string {
  return `/api/merchant/application/photo/${encodeURIComponent(fileId)}`;
}

/** MT2: a merchant accepts the merchant terms in force. */
export function acceptMerchantTerms(versionId: string, fetcher: Fetcher = fetch) {
  return apiRequest<null>('/api/merchant/terms', {
    method: 'POST',
    body: { versionId },
    fetcher,
  });
}
