import { type AdminPurchaseGames, normalizeSearchText } from '@vertex-digital/contracts';

/*
 * The sale picker of "شراء من اللوحة" (S16 screens): the most-sold row, the live game search and
 * the pack order and filter. Pure, so the page stays thin.
 */

export type SaleGame = AdminPurchaseGames['games'][number];

/** How many covers the most-sold row and the search show. */
export const TOP_GAMES = 8;
export const FOUND_GAMES = 8;

/**
 * The most-sold row: the last game an admin sold first, then by paid orders in the last 30 days,
 * active games before paused ones on a tie, then catalog order (the list's own order).
 */
export function topGames(games: readonly SaleGame[], lastGameId: string | null): SaleGame[] {
  const last = games.find((game) => game.id === lastGameId);
  const rest = games
    .map((game, order) => ({ game, order }))
    .filter(({ game }) => game !== last)
    .sort(
      (a, b) =>
        b.game.soldLast30Days - a.game.soldLast30Days ||
        Number(a.game.status !== 'active') - Number(b.game.status !== 'active') ||
        a.order - b.order,
    )
    .map(({ game }) => game);
  return [...(last ? [last] : []), ...rest].slice(0, TOP_GAMES);
}

const words = (text: string) => normalizeSearchText(text).split(' ').filter(Boolean);

/**
 * Live search by Arabic and English name and search terms (rule SR1's normalizing): every typed
 * word starts a word of the game, or appears in it from 3 letters. A name that starts with the
 * whole query ranks first, then the most sold, then catalog order.
 */
export function findGames(games: readonly SaleGame[], query: string): SaleGame[] {
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
        a.leading - b.leading || b.game.soldLast30Days - a.game.soldLast30Days || a.order - b.order,
    )
    .slice(0, FOUND_GAMES)
    .map((entry) => entry.game);
}

interface PackLike {
  nameAr: string;
  gameAmount: number | null;
  priceUsdUnits: number | null;
}

/** Packs by quantity (game amount), packs without one after, then by price, then name. */
export function sortPacks<Pack extends PackLike>(packs: readonly Pack[]): Pack[] {
  const big = Number.MAX_SAFE_INTEGER;
  return [...packs].sort(
    (a, b) =>
      (a.gameAmount ?? big) - (b.gameAmount ?? big) ||
      (a.priceUsdUnits ?? big) - (b.priceUsdUnits ?? big) ||
      a.nameAr.localeCompare(b.nameAr, 'ar'),
  );
}

/** The quick filter within a game's packs ("60"): the name or the game amount holds the text. */
export function filterPacks<Pack extends PackLike>(packs: readonly Pack[], text: string): Pack[] {
  const query = normalizeSearchText(text);
  if (query === '') return [...packs];
  return packs.filter(
    (pack) =>
      normalizeSearchText(pack.nameAr).includes(query) ||
      (pack.gameAmount !== null && String(pack.gameAmount).includes(query)),
  );
}
