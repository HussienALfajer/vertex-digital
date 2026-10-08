import { USDT_METHODS, type UsdtMethod } from '@vertex-digital/contracts';

/*
 * The USDT transfers page's filters as the URL holds them (rule U13): the unmatched transfers of
 * every network by default.
 */

export interface TransferSearch {
  method?: UsdtMethod;
  /** Absent for the unmatched transfers only. */
  state?: 'all';
}

/** Keeps only what is valid; anything else in the URL is dropped. */
export function parseTransferSearch(search: Record<string, unknown>): TransferSearch {
  const parsed: TransferSearch = {};
  if (search.state === 'all') parsed.state = 'all';
  if ((USDT_METHODS as readonly unknown[]).includes(search.method)) {
    parsed.method = search.method as UsdtMethod;
  }
  return parsed;
}
