import type { ImportDraftPack } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import {
  alignedRows,
  type FieldRow,
  importBody,
  importMaps,
  initialFieldRows,
  initialPackRows,
  linkBody,
  packGroups,
  refusalsByOffer,
  sentOffers,
  wholeNumber,
  withOptionRefusals,
} from './category-import';

const pack = (offerId: string, values: Partial<ImportDraftPack> = {}): ImportDraftPack => ({
  offerId,
  supplierOfferId: offerId,
  name: offerId,
  leafCategoryId: 'leaf-1',
  leafName: 'Global',
  kind: 'direct',
  costUsdUnits: 1_000_000,
  originalCostUsdUnits: null,
  discountPercent: null,
  stock: null,
  stockLevel: 'unlimited',
  requiredFields: ['player_id'],
  fieldSpecs: null,
  refusal: null,
  suggestedNameAr: `${offerId} name`,
  suggestedGameAmount: 60,
  pricePreviewUsdUnits: 1_200_000,
  match: null,
  ...values,
});

const field: FieldRow = {
  supplierKey: 'Player-ID',
  key: 'player_id',
  labelAr: 'معرّف اللاعب',
  type: 'digits',
  minLength: '1',
  maxLength: '32',
  required: true,
  options: [],
};

const region: FieldRow = {
  supplierKey: 'server',
  key: 'server',
  labelAr: 'السيرفر',
  type: 'select',
  minLength: '',
  maxLength: '',
  required: true,
  options: [
    { value: 'asia', labelAr: 'Asia', supplierValue: 'Asia' },
    { value: 'eu', labelAr: 'أوروبا', supplierValue: 'Europe' },
    { value: 'mars', labelAr: 'Mars', supplierValue: null },
  ],
};

describe('packGroups', () => {
  it('groups by leaf in the draft order', () => {
    const groups = packGroups([
      pack('a'),
      pack('b', { leafCategoryId: 'leaf-2', leafName: 'MENA' }),
      pack('c'),
    ]);
    expect(
      groups.map((group) => [group.leafName, group.packs.map((item) => item.offerId)]),
    ).toEqual([
      ['Global', ['a', 'c']],
      ['MENA', ['b']],
    ]);
  });
});

describe('initialPackRows', () => {
  it('selects the packs that can be chosen, up to 100, with the suggestions and matches', () => {
    const packs = [
      pack('a', { match: { productId: 'p-1', nameAr: 'UC 60' } }),
      pack('b', { refusal: 'OFFER_UNSUPPORTED', suggestedGameAmount: null }),
      pack('o', { refusal: 'FIELD_OPTIONS_DIFFER' }),
      ...Array.from({ length: 101 }, (_, index) => pack(`x${index}`)),
    ];
    const rows = initialPackRows({ packs });
    expect(rows[0]).toEqual({
      offerId: 'a',
      selected: true,
      nameAr: 'a name',
      gameAmount: '60',
      productId: 'p-1',
    });
    expect(rows[1]).toMatchObject({ selected: false, gameAmount: '', productId: null });
    // Refused for its options only: selected, and kept out by `alignedRows` until mapped.
    expect(rows[2]?.selected).toBe(true);
    expect(rows.filter((row) => row.selected)).toHaveLength(100);
    expect(rows.at(-1)?.selected).toBe(false);
  });
});

describe('alignedRows', () => {
  it('unselects packs refused since and adds packs the draft gained', () => {
    const rows = initialPackRows({ packs: [pack('a'), pack('b')] });
    expect(
      alignedRows({ packs: [pack('a', { refusal: 'OFFER_IGNORED' }), pack('b'), pack('c')] }, rows),
    ).toEqual([
      { ...rows[0], selected: false },
      rows[1],
      { offerId: 'c', selected: false, nameAr: 'c name', gameAmount: '60', productId: null },
    ]);
  });
});

describe('initialFieldRows', () => {
  it('keeps the supplier key beside the suggested field', () => {
    expect(
      initialFieldRows({
        fields: [
          {
            supplierKey: 'Player-ID',
            supplierLabel: 'Player ID',
            supplierType: 'text',
            supplierOptions: null,
            key: 'player_id',
            labelAr: 'معرّف اللاعب',
            type: 'digits',
            minLength: 1,
            maxLength: 32,
            options: null,
            required: true,
          },
          {
            supplierKey: 'server',
            supplierLabel: 'Server',
            supplierType: 'select',
            supplierOptions: [
              { label: 'Asia', value: 'Asia' },
              { label: 'Europe', value: 'Europe' },
            ],
            key: 'server',
            labelAr: 'السيرفر',
            type: 'select',
            minLength: null,
            maxLength: null,
            options: [
              { value: 'asia', labelAr: 'Asia' },
              { value: 'eu', labelAr: 'أوروبا' },
              { value: 'mars', labelAr: 'Mars' },
            ],
            required: true,
          },
        ],
        optionMap: { server: { asia: 'Asia', eu: 'Europe' } },
      }),
    ).toEqual([field, region]);
  });
});

describe('option maps (S16 MF2, MF3)', () => {
  const specs = (values: string[]) => [
    { key: 'Player-ID', label: 'ID', type: 'text' as const },
    {
      key: 'server',
      label: 'Server',
      type: 'select' as const,
      options: values.map((value) => ({ label: value, value })),
    },
  ];

  it('sends each option with its supplier value, and lists our selects', () => {
    expect(importMaps([field, region, { ...region, supplierKey: null, key: 'own' }])).toEqual({
      fieldMap: { 'Player-ID': 'player_id', server: 'server' },
      optionMap: { server: { asia: 'Asia', eu: 'Europe' } },
      selects: { server: ['asia', 'eu', 'mars'], own: ['asia', 'eu', 'mars'] },
    });
  });

  it('reads a pack’s option refusal again as options are removed, keeping other refusals', () => {
    const draft = {
      packs: [
        pack('a', { fieldSpecs: specs(['Asia', 'Europe']), refusal: 'FIELD_OPTIONS_DIFFER' }),
        pack('b', { fieldSpecs: specs(['Asia']), refusal: 'FIELD_OPTIONS_DIFFER' }),
        pack('c', { refusal: 'OFFER_IGNORED' }),
      ],
    };
    const withoutMars = { ...region, options: region.options.slice(0, 2) };
    const live = withOptionRefusals(draft, importMaps([field, withoutMars]));
    expect(live.packs.map((item) => item.refusal)).toEqual([
      null,
      'FIELD_OPTIONS_DIFFER',
      'OFFER_IGNORED',
    ]);
    expect(
      withOptionRefusals(draft, importMaps([field, region])).packs.map((item) => item.refusal),
    ).toEqual(['FIELD_OPTIONS_DIFFER', 'FIELD_OPTIONS_DIFFER', 'OFFER_IGNORED']);
  });
});

describe('wholeNumber', () => {
  it('reads empty as null and refuses anything but digits', () => {
    expect(wholeNumber(' 60 ')).toBe(60);
    expect(wholeNumber('')).toBeNull();
    expect(wholeNumber('6.5')).toBeNaN();
  });
});

describe('the bodies', () => {
  const rows = [
    { offerId: 'a', selected: true, nameAr: 'UC 60', gameAmount: '60', productId: 'p-1' },
    { offerId: 'b', selected: false, nameAr: 'UC 325', gameAmount: '', productId: null },
    { offerId: 'c', selected: true, nameAr: 'UC 660', gameAmount: '', productId: null },
  ];

  it('imports the selected packs with the fields and their map', () => {
    expect(
      importBody({
        game: { slug: 'pubg', categoryId: 'cat', nameAr: 'ببجي', nameEn: 'PUBG' },
        cover: { supplierImage: true },
        fields: [
          field,
          { ...field, supplierKey: null, key: 'note', type: 'text', maxLength: '' },
          region,
        ],
        rows,
      }),
    ).toEqual({
      game: { slug: 'pubg', categoryId: 'cat', nameAr: 'ببجي', nameEn: 'PUBG' },
      cover: { supplierImage: true },
      fields: [
        {
          key: 'player_id',
          labelAr: 'معرّف اللاعب',
          type: 'digits',
          required: true,
          minLength: 1,
          maxLength: 32,
        },
        {
          key: 'note',
          labelAr: 'معرّف اللاعب',
          type: 'text',
          required: true,
          minLength: 1,
          maxLength: null,
        },
        {
          key: 'server',
          labelAr: 'السيرفر',
          type: 'select',
          required: true,
          options: [
            { value: 'asia', labelAr: 'Asia' },
            { value: 'eu', labelAr: 'أوروبا' },
            { value: 'mars', labelAr: 'Mars' },
          ],
        },
      ],
      fieldMap: { 'Player-ID': 'player_id', server: 'server' },
      optionMap: { server: { asia: 'Asia', eu: 'Europe' } },
      rows: [
        { offerId: 'a', nameAr: 'UC 60', gameAmount: 60 },
        { offerId: 'c', nameAr: 'UC 660' },
      ],
    });
  });

  it('links existing products and new packs', () => {
    expect(
      linkBody({
        gameId: 'g',
        fieldMap: { uid: 'player_id' },
        optionMap: { server: { eu: 'Europe' } },
        rows,
      }),
    ).toEqual({
      gameId: 'g',
      fieldMap: { uid: 'player_id' },
      optionMap: { server: { eu: 'Europe' } },
      rows: [
        { offerId: 'a', productId: 'p-1' },
        { offerId: 'c', nameAr: 'UC 660' },
      ],
    });
  });

  it('maps refused rows back to their offers', () => {
    const sent = sentOffers(rows);
    expect(sent).toEqual(['a', 'c']);
    const refusals = refusalsByOffer(
      [
        { index: 1, code: 'NAME_TAKEN' },
        { index: 5, code: 'OFFER_MISSING' },
      ],
      sent,
    );
    expect([...refusals.entries()]).toEqual([['c', { index: 1, code: 'NAME_TAKEN' }]]);
  });
});
