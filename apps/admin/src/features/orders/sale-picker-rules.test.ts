import { describe, expect, it } from 'vitest';
import { filterPacks, findGames, type SaleGame, sortPacks, topGames } from './sale-picker-rules';

const game = (id: string, nameAr: string, nameEn: string, extra: Partial<SaleGame> = {}) =>
  ({
    id,
    categoryId: 'c',
    nameAr,
    nameEn,
    status: 'active',
    cover: null,
    searchTerms: [],
    soldLast30Days: 0,
    ...extra,
  }) as SaleGame;

const pubg = game('pubg', 'ببجي موبايل', 'PUBG Mobile', {
  soldLast30Days: 5,
  searchTerms: ['ببجي', 'بوبجي'],
});
const freeFire = game('ff', 'فري فاير', 'Free Fire', { soldLast30Days: 9 });
const legends = game('ml', 'موبايل ليجندز', 'Mobile Legends', { soldLast30Days: 2 });
const paused = game('p', 'لعبة موقوفة', 'Paused Game', { status: 'paused' });
const quiet = game('q', 'لعبة هادئة', 'Quiet Game');
const games = [pubg, paused, freeFire, legends, quiet];

describe('topGames', () => {
  it('puts the last game first, then the most sold, active before paused on a tie', () => {
    expect(topGames(games, 'ml').map((item) => item.id)).toEqual(['ml', 'ff', 'pubg', 'q', 'p']);
    expect(topGames(games, null).map((item) => item.id)).toEqual(['ff', 'pubg', 'ml', 'q', 'p']);
    expect(topGames(games, 'gone').map((item) => item.id)[0]).toBe('ff');
  });

  it('keeps eight', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      game(`g${index}`, `ل${index}`, `G${index}`),
    );
    expect(topGames(many, null)).toHaveLength(8);
  });
});

describe('findGames', () => {
  it('finds by Arabic name, English name and search terms, normalized', () => {
    expect(findGames(games, 'pubg').map((item) => item.id)).toEqual(['pubg']);
    expect(findGames(games, 'بوبجي').map((item) => item.id)).toEqual(['pubg']);
    expect(findGames(games, 'FREE fi').map((item) => item.id)).toEqual(['ff']);
    expect(findGames(games, 'فري').map((item) => item.id)).toEqual(['ff']);
  });

  it('ranks a leading name first, then the most sold', () => {
    // "موبايل" leads Mobile Legends' Arabic name and is a second word of PUBG's.
    expect(findGames(games, 'موبايل').map((item) => item.id)).toEqual(['ml', 'pubg']);
    expect(findGames(games, 'mobile').map((item) => item.id)).toEqual(['ml', 'pubg']);
  });

  it('matches inside a word from three letters, and finds nothing for an empty query', () => {
    expect(findGames(games, 'gend').map((item) => item.id)).toEqual(['ml']);
    expect(findGames(games, 'ub')).toEqual([]);
    expect(findGames(games, '  ')).toEqual([]);
    expect(findGames(games, 'pubg zzz')).toEqual([]);
  });
});

describe('packs', () => {
  const pack = (nameAr: string, gameAmount: number | null, priceUsdUnits: number | null) => ({
    nameAr,
    gameAmount,
    priceUsdUnits,
  });
  const packs = [
    pack('660 شدة', 660, 9_000_000),
    pack('بطاقة', null, 5_000_000),
    pack('60 شدة', 60, 1_000_000),
    pack('325 شدة', 325, 5_000_000),
    pack('اشتراك', null, null),
  ];

  it('sorts by quantity, then price, packs without a quantity last', () => {
    expect(sortPacks(packs).map((item) => item.nameAr)).toEqual([
      '60 شدة',
      '325 شدة',
      '660 شدة',
      'بطاقة',
      'اشتراك',
    ]);
  });

  it('filters by name or quantity, Arabic-Indic digits too', () => {
    expect(filterPacks(packs, '60').map((item) => item.nameAr)).toEqual(['660 شدة', '60 شدة']);
    expect(filterPacks(packs, '٣٢٥').map((item) => item.nameAr)).toEqual(['325 شدة']);
    expect(filterPacks(packs, 'بطاقه').map((item) => item.nameAr)).toEqual(['بطاقة']);
    expect(filterPacks(packs, ' ')).toHaveLength(5);
  });
});
