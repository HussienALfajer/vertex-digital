import { describe, expect, it } from 'vitest';
import {
  ACCENT_DARK_SURFACE,
  ACCENT_LIGHT_SURFACE,
  accentColorSchema,
  catalogImagePath,
  contrastRatio,
  createGameSchema,
  createInputFieldSchema,
  createProductSchema,
  gameListQuerySchema,
  inputFieldShapeSchema,
  missingForActivation,
  productAvailability,
  reorderSchema,
  slugSchema,
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
});
