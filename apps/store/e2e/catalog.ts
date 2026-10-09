import type { SearchIndex, Storefront, StoreGame, StoreProduct } from '@vertex-digital/contracts';
import fixtures from './catalog-fixtures.json' with { type: 'json' };

/*
 * The catalog of the E2E run: what e2e/catalog-server.mjs answers the store's server components,
 * and the search index the browser reads (mocked per test, rule SR2), built from the same data.
 */

export const CATALOG = fixtures as unknown as {
  storefront: Storefront;
  games: Record<string, StoreGame>;
};

export const PUBG = CATALOG.games['pubg-mobile'] as StoreGame;

/** A pack of a game by its Arabic name. */
export function pack(game: StoreGame, nameAr: string): StoreProduct {
  const found = game.products.find((product) => product.nameAr === nameAr);
  if (!found) throw new Error(`No pack ${nameAr}`);
  return found;
}

/** The admin's search terms (rule AD1): "ببجي" for PUBG Mobile, nothing for the others. */
const SEARCH_TERMS: Record<string, string[]> = { 'pubg-mobile': ['ببجي'] };

export function searchIndex(): SearchIndex {
  const shown = CATALOG.storefront.categories.flatMap((category) =>
    category.games.map((game) => ({ game, categoryNameAr: category.nameAr })),
  );
  return {
    games: shown.map(({ game, categoryNameAr }) => ({
      id: game.id,
      slug: game.slug,
      nameAr: game.nameAr,
      nameEn: game.nameEn,
      cover: game.cover,
      status: game.status,
      searchTerms: SEARCH_TERMS[game.slug] ?? [],
      categoryNameAr,
    })),
    products: shown.flatMap(({ game }) =>
      (CATALOG.games[game.slug]?.products ?? []).map((product) => ({
        id: product.id,
        nameAr: product.nameAr,
        gameAmount: product.gameAmount,
        available: product.available,
        priceUsdUnits: product.priceUsdUnits,
        priceSypUnits: product.priceSypUnits,
        gameSlug: game.slug,
      })),
    ),
  };
}
