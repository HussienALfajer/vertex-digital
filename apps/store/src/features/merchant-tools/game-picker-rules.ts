import {
  type CatalogImage,
  type MerchantGame,
  normalizeSearchText,
  type SearchIndex,
} from '@vertex-digital/contracts';

/*
 * The merchant area's game picker (owner, 2026-10-30; adapted from the admin panel's
 * `features/catalog/game-picker.tsx`): the games the merchant may sell, each with its cover, its
 * English name and search terms from the public search index (`GET /api/catalog/search-index`) and
 * its category from the merchant's games (`GET /api/merchant/games`, which also holds a game in
 * early access, absent from the public index). Pure, so the dialog stays thin.
 */

export interface PickerGame {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  cover: Pick<CatalogImage, 'id' | 'url' | 'width' | 'height'> | null;
  categoryId: string;
  categoryNameAr: string;
  /** The merchant's units of the last 30 days. */
  recentUnits: number;
  searchTerms: readonly string[];
}

/** How many covers "الأكثر مبيعًا" and the search show. */
export const TOP_PICKER_GAMES = 10;
export const FOUND_PICKER_GAMES = 8;

/** The merchant's games, in the store's order, joined with their public cards. */
export function pickerGames(
  games: readonly MerchantGame[],
  index: SearchIndex | null,
): PickerGame[] {
  const cards = new Map(index?.games.map((game) => [game.id, game]) ?? []);
  return games.map((game) => {
    const card = cards.get(game.id);
    return {
      id: game.id,
      slug: game.slug,
      nameAr: game.nameAr,
      nameEn: card?.nameEn ?? '',
      cover: card?.cover ?? null,
      categoryId: game.categoryId,
      categoryNameAr: game.categoryNameAr,
      recentUnits: game.recentUnits,
      searchTerms: card?.searchTerms ?? [],
    };
  });
}

/** The categories of `games`, in the store's order, each once. */
export function pickerCategories(games: readonly PickerGame[]): { id: string; nameAr: string }[] {
  const seen = new Map<string, string>();
  for (const game of games) {
    if (!seen.has(game.categoryId)) seen.set(game.categoryId, game.categoryNameAr);
  }
  return [...seen].map(([id, nameAr]) => ({ id, nameAr }));
}

/** "الأكثر مبيعًا": the merchant's top games of the last 30 days by units, ties in store order. */
export function topPickerGames(
  games: readonly PickerGame[],
  count = TOP_PICKER_GAMES,
): PickerGame[] {
  return games
    .map((game, order) => ({ game, order }))
    .filter(({ game }) => game.recentUnits > 0)
    .sort((a, b) => b.game.recentUnits - a.game.recentUnits || a.order - b.order)
    .slice(0, count)
    .map(({ game }) => game);
}

const words = (text: string) => normalizeSearchText(text).split(' ').filter(Boolean);

/**
 * Live search by Arabic and English name and search terms (rule SR1's normalizing): every typed
 * word starts a word of the game, or appears in it from 3 letters. A name that starts with the
 * whole query ranks first, then the merchant's units, then the store's order.
 */
export function findPickerGames(games: readonly PickerGame[], query: string): PickerGame[] {
  const typed = words(query);
  if (typed.length === 0) return [];
  const whole = typed.join(' ');
  return games
    .map((game, order) => {
      const names = [game.nameAr, game.nameEn].map(normalizeSearchText);
      const targets = [...names, ...game.searchTerms].flatMap((text) => words(text));
      const matches = typed.every((word) =>
        targets.some(
          (target) => target.startsWith(word) || (word.length >= 3 && target.includes(word)),
        ),
      );
      const leading = names.some((name) => name.startsWith(whole)) ? 0 : 1;
      return { game, order, matches, leading };
    })
    .filter((entry) => entry.matches)
    .sort(
      (a, b) =>
        a.leading - b.leading || b.game.recentUnits - a.game.recentUnits || a.order - b.order,
    )
    .slice(0, FOUND_PICKER_GAMES)
    .map(({ game }) => game);
}
