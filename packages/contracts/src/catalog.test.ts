import { describe, expect, it } from 'vitest';
import {
  ACCENT_DARK_SURFACE,
  ACCENT_LIGHT_SURFACE,
  accentColorSchema,
  CALCULATOR_MAX_TARGET,
  type CalculatorPack,
  catalogImagePath,
  catalogImageQuerySchema,
  cheapestPackCombination,
  contrastRatio,
  createGameSchema,
  createInputFieldSchema,
  createProductSchema,
  gameListQuerySchema,
  gameServiceStatus,
  inputFieldShapeSchema,
  missingForActivation,
  normalizeSearchText,
  productAvailability,
  reorderSchema,
  type SearchIndex,
  searchCatalog,
  searchTermsSchema,
  slugSchema,
  storeServiceState,
  updateGameSchema,
  updateProductSchema,
} from './catalog.js';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString().padStart(12, '0')}`;

describe('contrastRatio (rule CT6)', () => {
  it('matches known WCAG pairs', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    // #767676 on white is the classic 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBe(4.54);
  });

  it('rounds down, so the ratio shown is the one compared', () => {
    expect(contrastRatio('#F2A900', ACCENT_DARK_SURFACE)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#102020', ACCENT_DARK_SURFACE)).toBeLessThan(3);
    expect(contrastRatio('#F2A900', ACCENT_LIGHT_SURFACE)).toBeLessThan(3);
  });

  it('refuses anything but #RRGGBB', () => {
    expect(() => contrastRatio('#FFF', '#000000')).toThrow(RangeError);
    expect(() => contrastRatio('#000000', 'red')).toThrow(RangeError);
  });
});

describe('catalog values', () => {
  it('slugs are dash-separated lower-case words of 2–48 characters', () => {
    for (const slug of ['pubg-mobile', 'ff', 'gift-cards', 'a1-b2']) {
      expect(slugSchema.safeParse(slug).success).toBe(true);
    }
    for (const slug of ['a', 'PUBG', 'pubg--mobile', '-pubg', 'pubg-', 'ببجي', 'a'.repeat(49)]) {
      expect(slugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it('accent colors are #RRGGBB, stored upper case', () => {
    expect(accentColorSchema.parse(' #f2a900 ')).toBe('#F2A900');
    expect(accentColorSchema.safeParse('#F2A90').success).toBe(false);
    expect(accentColorSchema.safeParse('F2A900').success).toBe(false);
  });

  it('reorders name each id once', () => {
    expect(reorderSchema.safeParse({ ids: [id(1), id(2)] }).success).toBe(true);
    expect(reorderSchema.safeParse({ ids: [id(1), id(1)] }).success).toBe(false);
    expect(reorderSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('serves images by their id', () => {
    expect(catalogImagePath(id(1))).toBe(`/api/catalog/images/${id(1)}`);
  });
});

describe('games', () => {
  const game = {
    categoryId: id(1),
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    nameEn: 'PUBG Mobile',
  };

  it('take plain text: trimmed, no control characters, English names in Latin', () => {
    expect(createGameSchema.parse({ ...game, nameAr: '  ببجي  ' }).nameAr).toBe('ببجي');
    expect(createGameSchema.safeParse({ ...game, nameAr: 'a\u0000b' }).success).toBe(false);
    expect(createGameSchema.safeParse({ ...game, nameEn: 'ببجي' }).success).toBe(false);
    expect(createGameSchema.safeParse({ ...game, nameAr: '' }).success).toBe(false);
    const notes = 'سطر\nسطر';
    expect(createGameSchema.parse({ ...game, regionNotesAr: notes }).regionNotesAr).toBe(notes);
    expect(createGameSchema.safeParse({ ...game, regionNotesAr: 'a\tb' }).success).toBe(false);
  });

  it('never change their slug', () => {
    expect(updateGameSchema.parse({ slug: 'other', status: 'active' })).toEqual({
      status: 'active',
    });
  });

  it('list by page with filters', () => {
    expect(gameListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(
      gameListQuerySchema.parse({ page: '2', pageSize: '20', archived: 'true', q: ' pubg ' }),
    ).toEqual({
      page: 2,
      pageSize: 20,
      archived: 'true',
      q: 'pubg',
    });
    expect(gameListQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(gameListQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it('need a cover, and a required field when they sell direct top-ups (rule CT3)', () => {
    const complete = { hasCover: true, hasDirectProduct: true, hasRequiredField: true };
    expect(missingForActivation(complete)).toEqual([]);
    expect(missingForActivation({ ...complete, hasCover: false })).toEqual(['cover']);
    expect(missingForActivation({ ...complete, hasRequiredField: false })).toEqual([
      'input_fields',
    ]);
    expect(
      missingForActivation({ hasCover: false, hasDirectProduct: false, hasRequiredField: false }),
    ).toEqual(['cover']);
  });
});

describe('input fields (rule CT7)', () => {
  const base = { key: 'player_id', labelAr: 'معرّف اللاعب', required: true };

  it('take bounds by type', () => {
    expect(
      createInputFieldSchema.parse({ ...base, type: 'digits', minLength: 5, maxLength: 15 }),
    ).toEqual({
      ...base,
      type: 'digits',
      minLength: 5,
      maxLength: 15,
      options: null,
    });
    expect(
      createInputFieldSchema.safeParse({ ...base, type: 'digits', maxLength: 33 }).success,
    ).toBe(false);
    expect(createInputFieldSchema.safeParse({ ...base, type: 'text', maxLength: 64 }).success).toBe(
      true,
    );
    expect(createInputFieldSchema.safeParse({ ...base, type: 'text', maxLength: 65 }).success).toBe(
      false,
    );
    expect(
      createInputFieldSchema.safeParse({ ...base, type: 'digits', minLength: 9, maxLength: 5 })
        .success,
    ).toBe(false);
    expect(createInputFieldSchema.safeParse({ ...base, type: 'phone', minLength: 5 }).success).toBe(
      false,
    );
    expect(createInputFieldSchema.parse({ ...base, type: 'phone' })).toMatchObject({
      minLength: null,
      options: null,
    });
  });

  it('take 2–50 options with unique values for select only', () => {
    const options = [
      { value: 'eu', labelAr: 'أوروبا' },
      { value: 'asia', labelAr: 'آسيا' },
    ];
    expect(createInputFieldSchema.safeParse({ ...base, type: 'select', options }).success).toBe(
      true,
    );
    expect(
      createInputFieldSchema.safeParse({ ...base, type: 'select', options: [options[0]] }).success,
    ).toBe(false);
    expect(
      createInputFieldSchema.safeParse({
        ...base,
        type: 'select',
        options: [options[0], options[0]],
      }).success,
    ).toBe(false);
    expect(createInputFieldSchema.safeParse({ ...base, type: 'text', options }).success).toBe(
      false,
    );
    expect(
      createInputFieldSchema.safeParse({
        ...base,
        type: 'select',
        options: [{ value: 'EU', labelAr: 'x' }, options[1]],
      }).success,
    ).toBe(false);
  });

  it('take keys of a lower-case letter then 1–31 letters, digits or underscores', () => {
    for (const key of ['player_id', 'zone_id', 'ab']) {
      expect(createInputFieldSchema.safeParse({ ...base, key, type: 'phone' }).success).toBe(true);
    }
    for (const key of ['a', '1id', 'Player', 'player-id', `a${'b'.repeat(32)}`]) {
      expect(createInputFieldSchema.safeParse({ ...base, key, type: 'phone' }).success).toBe(false);
    }
  });

  it('check an update against the stored type', () => {
    expect(
      inputFieldShapeSchema.safeParse({ type: 'digits', minLength: 3, maxLength: 3 }).success,
    ).toBe(true);
    expect(inputFieldShapeSchema.safeParse({ type: 'select', options: null }).success).toBe(false);
  });
});

describe('products (rule CT8)', () => {
  it('default the maximum quantity by kind: 1 direct, 10 code', () => {
    expect(createProductSchema.parse({ kind: 'direct', nameAr: '60 UC' }).maxQuantity).toBe(1);
    expect(createProductSchema.parse({ kind: 'code', nameAr: 'بطاقة 10$' }).maxQuantity).toBe(10);
    expect(
      createProductSchema.safeParse({ kind: 'code', nameAr: 'x', maxQuantity: 51 }).success,
    ).toBe(false);
  });

  it('take region and redemption text for codes only', () => {
    const direct = createProductSchema.parse({ kind: 'direct', nameAr: '60 UC', regionAr: 'US' });
    expect(direct).not.toHaveProperty('regionAr');
    const code = createProductSchema.parse({
      kind: 'code',
      nameAr: 'بطاقة',
      regionAr: 'الولايات المتحدة',
      redemptionAr: 'افتح المتجر\nأدخل الرمز',
    });
    expect(code).toMatchObject({ regionAr: 'الولايات المتحدة' });
  });

  it('take an official price in whole cents, and never change the kind', () => {
    expect(
      createProductSchema.safeParse({ kind: 'direct', nameAr: 'x', officialPriceUsdUnits: 990_000 })
        .success,
    ).toBe(true);
    expect(
      createProductSchema.safeParse({ kind: 'direct', nameAr: 'x', officialPriceUsdUnits: 990_001 })
        .success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({ kind: 'direct', nameAr: 'x', officialPriceUsdUnits: 0 })
        .success,
    ).toBe(false);
    expect(updateProductSchema.parse({ kind: 'code', status: 'paused' })).toEqual({
      status: 'paused',
    });
  });

  it('derive availability in the order of rule CT9', () => {
    const facts = {
      categoryArchived: false,
      gameArchived: false,
      productArchived: false,
      gameStatus: 'active' as const,
      productStatus: 'active' as const,
      price: null,
      usableRouteCostsUsdUnits: [],
    };
    expect(productAvailability(facts)).toBe('out_of_stock');
    expect(productAvailability({ ...facts, productStatus: 'paused' })).toBe('paused');
    expect(productAvailability({ ...facts, gameStatus: 'paused' })).toBe('paused');
    expect(productAvailability({ ...facts, gameStatus: 'paused', productArchived: true })).toBe(
      'hidden',
    );
    expect(productAvailability({ ...facts, gameArchived: true })).toBe('hidden');
    expect(productAvailability({ ...facts, categoryArchived: true })).toBe('hidden');
  });

  it('follow the price and the usable routes (S07 rule P6)', () => {
    const facts = {
      categoryArchived: false,
      gameArchived: false,
      productArchived: false,
      gameStatus: 'active' as const,
      productStatus: 'active' as const,
      price: { priceUsdUnits: 990_000, minMarginUsdUnits: 100_000 },
      usableRouteCostsUsdUnits: [890_000],
    };
    // Exactly the minimum margin is profitable (rule PR5).
    expect(productAvailability(facts)).toBe('available');
    expect(productAvailability({ ...facts, usableRouteCostsUsdUnits: [] })).toBe('out_of_stock');
    expect(productAvailability({ ...facts, price: null })).toBe('out_of_stock');
    // A held price below cost plus the minimum: the guard pauses the product.
    expect(productAvailability({ ...facts, usableRouteCostsUsdUnits: [890_001] })).toBe(
      'paused_by_margin_guard',
    );
    // One profitable route among several is enough.
    expect(productAvailability({ ...facts, usableRouteCostsUsdUnits: [950_000, 880_000] })).toBe(
      'available',
    );
    expect(productAvailability({ ...facts, productStatus: 'paused' })).toBe('paused');
  });
});

describe('normalizeSearchText (S09 rule SR1)', () => {
  it('folds every Arabic letter form, removes marks and tatweel', () => {
    expect(normalizeSearchText('أإآٱ')).toBe('اااا');
    expect(normalizeSearchText('ة ى ؤ ئ')).toBe('ه ي و ي');
    expect(normalizeSearchText('بَبْجِيّ')).toBe('ببجي');
    expect(normalizeSearchText('فـــري فاير')).toBe('فري فاير');
    expect(normalizeSearchText('\u0670ا')).toBe('ا');
  });

  it('turns Arabic-Indic and Persian digits Latin, lower-cases and applies NFKC', () => {
    expect(normalizeSearchText('٦٠ شدة')).toBe('60 شده');
    expect(normalizeSearchText('۱۲۳')).toBe('123');
    expect(normalizeSearchText('ＰＵＢＧ Mobile')).toBe('pubg mobile');
  });

  it('turns punctuation into one space and trims', () => {
    expect(normalizeSearchText('  Free-Fire!!  (diamonds) ')).toBe('free fire diamonds');
    expect(normalizeSearchText('...')).toBe('');
  });

  it('stores search terms normalized, 0–20, unique, 1–40 characters', () => {
    expect(searchTermsSchema.parse(['ببجي', ' بوبجي '])).toEqual(['ببجي', 'بوبجي']);
    expect(searchTermsSchema.parse([])).toEqual([]);
    expect(searchTermsSchema.safeParse(['ببجي', 'بَبجي']).success).toBe(false);
    expect(searchTermsSchema.safeParse(['!!']).success).toBe(false);
    expect(searchTermsSchema.safeParse(['a'.repeat(41)]).success).toBe(false);
    expect(searchTermsSchema.safeParse(Array.from({ length: 21 }, (_, i) => `t${i}`)).success).toBe(
      false,
    );
  });
});

describe('searchCatalog (S09 rules SR3, SR4)', () => {
  const game = (
    n: number,
    nameAr: string,
    nameEn: string,
    extra: Partial<SearchIndex['games'][number]> = {},
  ) => ({
    id: id(n),
    slug: nameEn.toLowerCase().replace(/ /g, '-'),
    nameAr,
    nameEn,
    cover: null,
    status: 'normal' as const,
    searchTerms: [],
    categoryNameAr: 'ألعاب',
    ...extra,
  });
  const product = (n: number, gameSlug: string, nameAr: string, available = true) => ({
    id: id(n),
    gameSlug,
    nameAr,
    gameAmount: null,
    available,
    priceUsdUnits: available ? 1_000_000 : null,
    priceSypUnits: null,
  });
  const index: SearchIndex = {
    games: [
      game(1, 'ببجي موبايل', 'PUBG Mobile', { searchTerms: ['ببجي'] }),
      game(2, 'فري فاير', 'Free Fire', { status: 'unavailable' }),
      game(3, 'جواهر', 'Mobile Legends'),
      game(4, 'كول اوف ديوتي', 'Call of Duty Mobile'),
    ],
    products: [
      product(11, 'pubg-mobile', '60 UC'),
      product(12, 'pubg-mobile', '325 UC', false),
      product(13, 'pubg-mobile', '660 UC'),
      product(21, 'free-fire', '100 جوهرة'),
    ],
  };
  const games = (query: string) => searchCatalog(index, query).games.map((g) => g.nameEn);
  const packs = (query: string) => searchCatalog(index, query).products.map((p) => p.nameAr);

  it('finds games by exact, prefix and fuzzy tokens, exact first', () => {
    expect(games('pubg')).toEqual(['PUBG Mobile']);
    expect(games('mob')).toEqual(['PUBG Mobile', 'Mobile Legends', 'Call of Duty Mobile']);
    expect(games('ببجي')).toEqual(['PUBG Mobile']);
    // One edit for 4–7 characters (here a swap), two from 8.
    expect(games('بجبي')).toEqual(['PUBG Mobile']);
    expect(games('legnds')).toEqual(['Mobile Legends']);
    expect(games('legendsss')).toEqual(['Mobile Legends']);
    expect(games('legendsxyz')).toEqual([]);
    expect(games('mobilelegend')).toEqual([]);
    expect(games('legennds mobile')).toEqual(['Mobile Legends']);
    expect(games('callofdutt')).toEqual([]);
    // Short tokens are exact or a prefix only.
    expect(games('pbg')).toEqual([]);
    expect(games('p')).toEqual([]);
  });

  it('ranks an exact match over a prefix over a fuzzy one, then available games', () => {
    const ranked = searchCatalog(
      {
        games: [
          game(9, 'ج', 'Fier', { slug: 'fier' }),
          game(5, 'أ', 'Fires', { slug: 'fires' }),
          game(6, 'ب', 'Fire Two', { slug: 'fire-two', status: 'unavailable' }),
          game(7, 'ت', 'Firestorm', { slug: 'firestorm' }),
          game(8, 'ث', 'Fire', { slug: 'fire' }),
        ],
        products: [],
      },
      'fire',
    ).games.map((g) => g.slug);
    expect(ranked).toEqual(['fire', 'fire-two', 'fires', 'firestorm', 'fier']);
    expect(games('free fire')).toEqual(['Free Fire']);
  });

  it('matches packs through their game, digits only exactly or as a prefix', () => {
    expect(packs('ببجي 60')).toEqual(['60 UC']);
    expect(packs('pubg 66')).toEqual(['660 UC']);
    expect(packs('pubg 6')).toEqual([]);
    expect(packs('pubg 61')).toEqual([]);
    expect(packs('ببجي')).toEqual(['60 UC', '660 UC', '325 UC']);
    expect(packs('جوهره')).toEqual(['100 جوهرة']);
    expect(packs('٦٠')).toEqual(['60 UC']);
  });

  it('finds nothing for an empty query and keeps at most 6 games and 8 packs', () => {
    expect(searchCatalog(index, '  !! ')).toEqual({ games: [], products: [] });
    const many: SearchIndex = {
      games: Array.from({ length: 9 }, (_, i) => game(100 + i, 'لعبة', `Game ${i}`)),
      products: Array.from({ length: 12 }, (_, i) => product(200 + i, 'game-0', `${i} pack`)),
    };
    expect(searchCatalog(many, 'game').games).toHaveLength(6);
    expect(searchCatalog(many, 'game').products).toHaveLength(8);
    expect(
      searchCatalog({ games: [], products: [product(1, 'gone', 'x pack')] }, 'pack').products,
    ).toHaveLength(1);
  });
});

describe('cheapestPackCombination (S09 rules CL2, CL3)', () => {
  const pack = (n: number, gameAmount: number, priceUsdUnits: number): CalculatorPack => ({
    id: id(n),
    gameAmount,
    priceUsdUnits,
  });
  const uc60 = pack(1, 60, 990_000);
  const uc325 = pack(2, 325, 4_990_000);
  const uc660 = pack(3, 660, 9_990_000);

  it('hits a target exactly when that is cheapest', () => {
    expect(cheapestPackCombination([uc60, uc325, uc660], 120)).toEqual({
      lines: [{ packId: uc60.id, count: 2 }],
      totalAmount: 120,
      totalUsdUnits: 1_980_000,
      overshoot: 0,
    });
  });

  it('overshoots when that is cheaper, mixing packs', () => {
    expect(cheapestPackCombination([uc60, uc325, uc660], 1000)).toEqual({
      lines: [
        { packId: uc60.id, count: 6 },
        { packId: uc325.id, count: 2 },
      ],
      totalAmount: 1010,
      totalUsdUnits: 15_920_000,
      overshoot: 10,
    });
    expect(cheapestPackCombination([uc60, uc660], 1)).toMatchObject({
      lines: [{ packId: uc60.id, count: 1 }],
      overshoot: 59,
    });
  });

  it('breaks price ties by fewer packs, then by the smaller overshoot', () => {
    const small = pack(4, 10, 1_000_000);
    const double = pack(5, 20, 2_000_000);
    expect(cheapestPackCombination([small, double], 40)?.lines).toEqual([
      { packId: double.id, count: 2 },
    ]);
    const exact = pack(6, 30, 3_000_000);
    const over = pack(7, 35, 3_000_000);
    expect(cheapestPackCombination([over, exact], 30)?.lines).toEqual([
      { packId: exact.id, count: 1 },
    ]);
    const bigOver = pack(8, 50, 3_000_000);
    // One pack of 50 beats two packs reaching 30 at the same price.
    expect(cheapestPackCombination([small, double, bigOver], 25)).toMatchObject({
      lines: [{ packId: bigOver.id, count: 1 }],
      overshoot: 25,
    });
    const pricier = pack(9, 26, 3_500_000);
    expect(cheapestPackCombination([pricier, small], 25)?.lines).toEqual([
      { packId: small.id, count: 3 },
    ]);
  });

  it('handles a single pack, the smallest and largest targets, and no packs', () => {
    expect(cheapestPackCombination([uc660], 1000)).toMatchObject({
      lines: [{ packId: uc660.id, count: 2 }],
      totalAmount: 1320,
    });
    expect(
      cheapestPackCombination([uc60, uc325, uc660], CALCULATOR_MAX_TARGET)?.totalAmount,
    ).toBeGreaterThanOrEqual(CALCULATOR_MAX_TARGET);
    expect(cheapestPackCombination([], 10)).toBeNull();
    expect(() => cheapestPackCombination([uc60], 0)).toThrow(RangeError);
    expect(() => cheapestPackCombination([uc60], CALCULATOR_MAX_TARGET + 1)).toThrow(RangeError);
    expect(() => cheapestPackCombination([uc60], 1.5)).toThrow(RangeError);
  });
});

describe('service status (S09 rules SS1, SS2)', () => {
  it('reads a game normal, slow or unavailable', () => {
    expect(
      gameServiceStatus([
        { available: false, healthyAutomaticBasis: false },
        { available: true, healthyAutomaticBasis: true },
      ]),
    ).toBe('normal');
    expect(gameServiceStatus([{ available: true, healthyAutomaticBasis: false }])).toBe('slow');
    expect(gameServiceStatus([{ available: false, healthyAutomaticBasis: true }])).toBe(
      'unavailable',
    );
    expect(gameServiceStatus([])).toBe('unavailable');
  });

  it('turns the line slow only for a slow game', () => {
    expect(storeServiceState(['normal', 'unavailable'])).toBe('normal');
    expect(storeServiceState(['normal', 'slow'])).toBe('slow');
    expect(storeServiceState([])).toBe('normal');
  });

  it('serves images only at the store widths', () => {
    expect(catalogImageQuerySchema.parse({ w: '640' })).toEqual({ w: 640 });
    expect(catalogImageQuerySchema.parse({})).toEqual({});
    expect(catalogImageQuerySchema.safeParse({ w: '500' }).success).toBe(false);
  });
});
