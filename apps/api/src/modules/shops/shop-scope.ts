import { AsyncLocalStorage } from 'node:async_hooks';

/*
 * The shop of the request in flight (ADR 0040): the shop customers' Better Auth instance scopes
 * every user and session lookup to it. Set by the auth handler's middleware and by the access
 * guard from the path's `:slug`; a lookup outside a scope throws, never reads across shops.
 */

const scope = new AsyncLocalStorage<string>();

/** Runs `work` with `shopId` as the request's shop. */
export function inShop<T>(shopId: string, work: () => T): T {
  return scope.run(shopId, work);
}

/** The request's shop, or a thrown error: no shop realm read runs without one. */
export function currentShopId(): string {
  const shopId = scope.getStore();
  if (!shopId) throw new Error('A shop customer lookup ran outside a shop scope');
  return shopId;
}
