import type { MerchantPriceListGame } from '@vertex-digital/contracts';

/*
 * The price list's preview as A4 pages (owner, 2026-10-30): how many pack lines one page holds
 * under the shop's header (the first) and without it, a game's title counting as two lines. A game
 * that runs over a page goes on with its title again. The print page leaves the cut to the browser.
 */

export const FIRST_PAGE_LINES = 18;
export const PAGE_LINES = 26;
const TITLE_LINES = 2;

export function a4Pages(games: readonly MerchantPriceListGame[]): MerchantPriceListGame[][] {
  const pages: MerchantPriceListGame[][] = [];
  let page: MerchantPriceListGame[] = [];
  let left = FIRST_PAGE_LINES;
  const next = () => {
    pages.push(page);
    page = [];
    left = PAGE_LINES;
  };
  for (const game of games) {
    let from = 0;
    while (from < game.rows.length) {
      // A title never ends a page alone.
      if (left < TITLE_LINES + 1) next();
      const take = Math.min(game.rows.length - from, left - TITLE_LINES);
      page.push({ ...game, rows: game.rows.slice(from, from + take) });
      left -= TITLE_LINES + take;
      from += take;
    }
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}
