import type { MerchantPriceListGame } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { a4Pages, FIRST_PAGE_LINES, PAGE_LINES } from './price-list-pages';

const game = (id: string, rows: number): MerchantPriceListGame => ({
  gameId: id,
  nameAr: id,
  rows: Array.from({ length: rows }, (_, index) => ({
    productId: `${id}-${index}`,
    nameAr: String(index),
    available: true,
    usdUnits: 1_000_000,
    sypUnits: null,
  })),
});

const shape = (pages: MerchantPriceListGame[][]) =>
  pages.map((page) => page.map((item) => `${item.gameId}:${item.rows.length}`));

describe('the price list as A4 pages (owner, 2026-10-30)', () => {
  it('holds a short list on one page, and an empty one on one empty page', () => {
    expect(shape(a4Pages([game('a', 5), game('b', 3)]))).toEqual([['a:5', 'b:3']]);
    expect(a4Pages([])).toEqual([[]]);
  });

  it('runs a long game over the next page with its title again', () => {
    const first = FIRST_PAGE_LINES - 2;
    expect(shape(a4Pages([game('a', first + 10)]))).toEqual([[`a:${first}`], ['a:10']]);
    expect(shape(a4Pages([game('a', first + PAGE_LINES)]))).toEqual([
      [`a:${first}`],
      [`a:${PAGE_LINES - 2}`],
      ['a:2'],
    ]);
  });

  it('never leaves a title alone at the foot of a page', () => {
    // 15 + 2 lines leave one: too few for a title and a line.
    expect(shape(a4Pages([game('a', FIRST_PAGE_LINES - 3), game('b', 2)]))).toEqual([
      [`a:${FIRST_PAGE_LINES - 3}`],
      ['b:2'],
    ]);
  });
});
