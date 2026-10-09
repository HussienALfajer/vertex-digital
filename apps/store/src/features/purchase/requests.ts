import type {
  CreateOrder,
  Order,
  PlayerCheck,
  PlayerCheckRequest,
} from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The buy box's calls (S09 rules PV1, BB6): a player check, and the purchase or reservation. The
 * session cookie says who buys; never cached.
 */

type Fetcher = typeof fetch;

/** Rule PV6: valid (with the in-game name when the supplier gives it), invalid, unavailable. */
export function checkPlayer(body: PlayerCheckRequest, fetcher: Fetcher = fetch) {
  return apiRequest<PlayerCheck>('/api/player-checks', { method: 'POST', body, fetcher });
}

/**
 * Rules O1–O6, RS1: pays the order, or reserves it when the balance is short and `reserve` was
 * chosen. `key` is the attempt's `Idempotency-Key`: a retry of the same body sends the same key
 * and gets the first order back (`200`).
 */
export function createOrder(body: CreateOrder, key: string, fetcher: Fetcher = fetch) {
  return apiRequest<Order>('/api/orders', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': key },
    fetcher,
  });
}
