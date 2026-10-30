import type { MerchantGame, SearchIndex } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import {
  findPickerGames,
  type PickerGame,
  pickerCategories,
  pickerGames,
  topPickerGames,
} from './game-picker-rules';

const game = (id: string, changes: Partial<PickerGame> = {}): PickerGame => ({
  id,
  slug: id,
  nameAr: id,
  nameEn: id,
  cover: null,
  categoryId: 'games',
  categoryNameAr: 'ألعاب',
  recentUnits: 0,
  searchTerms: [],
  ...changes,
});

describe('the merchant game picker (owner, 2026-10-30)', () => {
  it('joins the merchant games with their public cards, and keeps a game the index lacks', () => {
    const games: MerchantGame[] = [
      {
        id: 'a',
        slug: 'pubg',
        nameAr: 'ببجي',
        categoryId: 'c1',
        categoryNameAr: 'ألعاب',
        recentUnits: 3,
      },
      {
        id: 'b',
        slug: 'early',
        nameAr: 'مبكرة',
        categoryId: 'c2',
        categoryNameAr: 'تطبيقات',
        recentUnits: 0,
      },
    ];
    const index = {
      games: [
        {
          id: 'a',
          slug: 'pubg',
          nameAr: 'ببجي',
          nameEn: 'PUBG Mobile',
          cover: null,
          status: 'normal',
          searchTerms: ['uc'],
          categoryNameAr: 'ألعاب',
        },
      ],
      products: [],
    } as unknown as SearchIndex;
    const joined = pickerGames(games, index);
    expect(joined[0]).toMatchObject({ nameEn: 'PUBG Mobile', searchTerms: ['uc'], recentUnits: 3 });
    expect(joined[1]).toMatchObject({ nameEn: '', cover: null, categoryNameAr: 'تطبيقات' });
    expect(pickerGames(games, null)[0]?.nameEn).toBe('');
    expect(pickerCategories(joined)).toEqual([
      { id: 'c1', nameAr: 'ألعاب' },
      { id: 'c2', nameAr: 'تطبيقات' },
    ]);
  });

  it('finds by Arabic, English and search terms, the leading name first', () => {
    const games = [
      game('ff', { nameAr: 'فري فاير', nameEn: 'Free Fire', recentUnits: 1 }),
      game('pubg', { nameAr: 'ببجي موبايل', nameEn: 'PUBG Mobile', searchTerms: ['شدات'] }),
      game('fifa', { nameAr: 'فيفا', nameEn: 'EA FC Mobile' }),
    ];
    expect(findPickerGames(games, 'ببجي').map((item) => item.id)).toEqual(['pubg']);
    expect(findPickerGames(games, 'free').map((item) => item.id)).toEqual(['ff']);
    expect(findPickerGames(games, 'شدات').map((item) => item.id)).toEqual(['pubg']);
    expect(findPickerGames(games, 'mobile').map((item) => item.id)).toEqual(['pubg', 'fifa']);
    expect(findPickerGames(games, '   ')).toEqual([]);
  });

  it('ranks the merchant’s own sales, never a game without any', () => {
    const games = [
      game('a', { recentUnits: 1 }),
      game('b'),
      game('c', { recentUnits: 5 }),
      game('d', { recentUnits: 1 }),
    ];
    expect(topPickerGames(games).map((item) => item.id)).toEqual(['c', 'a', 'd']);
    expect(topPickerGames(games, 1).map((item) => item.id)).toEqual(['c']);
  });
});
