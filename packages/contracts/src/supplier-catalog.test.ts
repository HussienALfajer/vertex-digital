import { describe, expect, it } from 'vitest';
import { activateAllResultSchema } from './catalog.js';
import { isNearbySupplierOrder, supplierOrderPageSchema } from './orders.js';
import {
  type CategoryNodeFacts,
  type CategoryOfferFacts,
  categoryStandings,
  discountPercent,
  importCategorySchema,
  linkCategorySchema,
  optionMapSchema,
  PANEL_READ_OPERATIONS,
  parseGameAmount,
  proposeOptionMap,
  SUPPLIER_POLICY_DEFAULTS,
  stockAlertChange,
  stockLevel,
  suggestInputFields,
  suggestProductName,
  supplierCategoryListQuerySchema,
  supplierHealth,
  supplierPanelCapabilities,
  supplierPolicySchema,
  unmappedOptions,
} from './suppliers.js';

/*
 * S16's supplier catalog rules (SC5, SC12, SC13, SF1, SF2, SF4) and the shapes they check.
 */

const node = (
  categoryId: string,
  parentCategoryId: string | null,
  extra: Partial<CategoryNodeFacts> = {},
): CategoryNodeFacts => ({ categoryId, parentCategoryId, gameId: null, ignored: false, ...extra });

const offer = (
  categoryId: string | null,
  extra: Partial<CategoryOfferFacts> = {},
): CategoryOfferFacts => ({
  categoryId,
  mapped: false,
  ignored: false,
  supported: true,
  inStock: true,
  missing: false,
  ...extra,
});

const GAME = '0190a000-0000-7000-8000-000000000001';

describe('category states (rule SC5)', () => {
  it('is not imported without an effective game, and counts its subtree', () => {
    const standings = categoryStandings(
      [node('root', null), node('leaf', 'root')],
      [offer('leaf'), offer('leaf', { mapped: true }), offer('leaf', { supported: false })],
    );
    expect(standings.get('root')).toEqual({
      state: 'not_imported',
      effectiveGameId: null,
      mapped: 1,
      unmapped: 2,
      ignored: 0,
      unsupported: 1,
      newPacks: 0,
    });
  });

  it('inherits the nearest linked ancestor and counts new packs up the tree', () => {
    const standings = categoryStandings(
      [node('root', null, { gameId: GAME }), node('mid', 'root'), node('leaf', 'mid')],
      [offer('leaf')],
    );
    expect(standings.get('leaf')).toMatchObject({ state: 'new_packs', effectiveGameId: GAME });
    expect(standings.get('mid')).toMatchObject({ state: 'new_packs', newPacks: 1 });
    expect(standings.get('root')).toMatchObject({ state: 'new_packs', newPacks: 1 });
  });

  it('is linked when nothing new is left, whatever blocks an offer', () => {
    const standings = categoryStandings(
      [node('root', null, { gameId: GAME })],
      [
        offer('root', { mapped: true }),
        offer('root', { ignored: true }),
        offer('root', { supported: false }),
        offer('root', { inStock: false }),
        offer('root', { missing: true }),
      ],
    );
    expect(standings.get('root')).toMatchObject({ state: 'linked', ignored: 1, newPacks: 0 });
  });

  it('is ignored when it or an ancestor is ignored, before anything else', () => {
    const standings = categoryStandings(
      [node('root', null, { ignored: true, gameId: GAME }), node('leaf', 'root')],
      [offer('leaf')],
    );
    expect(standings.get('root')?.state).toBe('ignored');
    expect(standings.get('leaf')?.state).toBe('ignored');
  });

  it('ends at a parent it does not hold, stops on a cycle and skips unknown leaves', () => {
    const standings = categoryStandings(
      [node('orphan', 'gone'), node('a', 'b', { gameId: GAME }), node('b', 'a')],
      [offer(null), offer('nowhere'), offer('b')],
    );
    expect(standings.get('orphan')?.state).toBe('not_imported');
    expect(standings.get('b')).toMatchObject({ state: 'new_packs', effectiveGameId: GAME });
    expect(standings.get('a')).toMatchObject({ newPacks: 1 });
  });
});

describe('field suggestions (rule SC12)', () => {
  it('keys, Arabic labels, types and the field map', () => {
    const { fields, fieldMap } = suggestInputFields([
      { key: 'player_id', label: 'Player ID' },
      { key: 'Zone-ID', label: 'Zone' },
      { key: 'riot_id', label: 'Riot' },
      { key: 'nickname', label: '  Nick name  ' },
      { key: '9lives', label: '' },
      { key: 'x', label: 'X' },
      { key: 'player_id', label: 'again' },
    ]);
    expect(fields.map((field) => [field.key, field.labelAr, field.type, field.maxLength])).toEqual([
      ['player_id', 'معرّف اللاعب', 'digits', 32],
      ['zone_id', 'رقم المنطقة', 'digits', 32],
      ['riot_id', 'Riot ID', 'text', 64],
      ['nickname', 'Nick name', 'text', 64],
      ['f_9lives', 'f_9lives', 'text', 64],
      ['x_f', 'X', 'text', 64],
    ]);
    expect(fields.every((field) => field.required && field.minLength === 1)).toBe(true);
    expect(fieldMap).toEqual({
      player_id: 'player_id',
      'Zone-ID': 'zone_id',
      riot_id: 'riot_id',
      nickname: 'nickname',
      '9lives': 'f_9lives',
      x: 'x_f',
    });
  });

  it('cuts to 32 and makes keys unique', () => {
    const long = 'a'.repeat(40);
    const { fields } = suggestInputFields([
      { key: 'server-id', label: 'S' },
      { key: 'server.id', label: 'S' },
      { key: long, label: 'L' },
      { key: `${long}b`, label: 'L' },
    ]);
    expect(fields.map((field) => field.key)).toEqual([
      'server_id',
      'server_id_2',
      'a'.repeat(32),
      `${'a'.repeat(30)}_2`,
    ]);
  });
});

describe('select fields and option maps (rules MF2, MF3)', () => {
  const server = {
    key: 'server',
    label: 'Server',
    type: 'select' as const,
    options: [
      { label: 'South America', value: 'south_america' },
      { label: 'Asia', value: 'Asia' },
      { label: 'asia', value: 'ASIA' },
      { label: '  ', value: 'EU West' },
    ],
  };

  it('turns a supplier select into ours with sanitized unique values and the option map', () => {
    const { fields, fieldMap, optionMap } = suggestInputFields([
      { key: 'player_id', label: 'Player ID', type: 'text' },
      server,
    ]);
    expect(fields[1]).toEqual({
      supplierKey: 'server',
      key: 'server',
      labelAr: 'السيرفر',
      type: 'select',
      minLength: null,
      maxLength: null,
      options: [
        { value: 'south_america', labelAr: 'South America' },
        { value: 'asia', labelAr: 'Asia' },
        { value: 'asia_2', labelAr: 'asia' },
        { value: 'eu_west', labelAr: 'eu_west' },
      ],
      required: true,
    });
    expect(fields[0]?.options).toBeNull();
    expect(fieldMap).toEqual({ player_id: 'player_id', server: 'server' });
    expect(optionMap).toEqual({
      server: { south_america: 'south_america', asia: 'Asia', asia_2: 'ASIA', eu_west: 'EU West' },
    });
  });

  it('keeps a select with fewer than 2 or more than 50 options as text', () => {
    const many = Array.from({ length: 51 }, (_, n) => ({ label: `S${n}`, value: `s${n}` }));
    const { fields, optionMap } = suggestInputFields([
      { key: 'zone', label: 'Zone', type: 'select', options: [{ label: 'A', value: 'a' }] },
      { key: 'realm', label: 'Realm', type: 'select', options: many },
      { key: 'shard', label: 'Shard', type: 'select' },
    ]);
    expect(fields.map((field) => field.type)).toEqual(['text', 'text', 'text']);
    expect(optionMap).toEqual({});
  });

  it('proposes our options onto the supplier list by value, label or sanitized value', () => {
    expect(
      proposeOptionMap(
        [
          { value: 'asia', labelAr: 'آسيا' },
          { value: 'eu', labelAr: ' Europe ' },
          { value: 'na_east', labelAr: 'شرق' },
          { value: 'mars', labelAr: 'المريخ' },
        ],
        [
          { label: 'Asia', value: 'asia' },
          { label: 'europe', value: 'EU-1' },
          { label: 'NA', value: 'NA East' },
        ],
      ),
    ).toEqual({ asia: 'asia', eu: 'EU-1', na_east: 'NA East' });
  });

  it('lists the supplier selects a route cannot send from every option', () => {
    const specs = [
      { key: 'player_id', label: 'ID', type: 'text' as const },
      {
        key: 'server',
        label: 'Server',
        type: 'select' as const,
        options: [
          { label: 'Asia', value: 'Asia' },
          { label: 'Europe', value: 'Europe' },
        ],
      },
    ];
    const fieldMap = { player_id: 'player_id', server: 'server' };
    const selects = { server: ['asia', 'eu'] };
    const full = { server: { asia: 'Asia', eu: 'Europe' } };
    expect(unmappedOptions(specs, fieldMap, full, selects)).toEqual([]);
    expect(unmappedOptions(null, fieldMap, {}, selects)).toEqual([]);
    expect(unmappedOptions(specs, { player_id: 'player_id' }, {}, selects)).toEqual([]);
    expect(unmappedOptions(specs, fieldMap, {}, selects)).toEqual(['server']);
    expect(unmappedOptions(specs, fieldMap, { server: { asia: 'Asia' } }, selects)).toEqual([
      'server',
    ]);
    expect(
      unmappedOptions(specs, fieldMap, { server: { asia: 'Asia', eu: 'Mars' } }, selects),
    ).toEqual(['server']);
    expect(
      unmappedOptions(
        [{ key: 'shard', label: 'S', type: 'select' }],
        { shard: 'shard' },
        {},
        {
          shard: ['a'],
        },
      ),
    ).toEqual(['shard']);
    // A supplier select needs one of our selects.
    expect(unmappedOptions(specs, fieldMap, full, {})).toEqual(['server']);
    // Options the supplier lists and we do not are fine.
    expect(
      unmappedOptions(specs, fieldMap, { server: { asia: 'Asia' } }, { server: ['asia'] }),
    ).toEqual([]);
  });

  it('bounds the option map', () => {
    expect(optionMapSchema.safeParse({ server: { asia: 'Asia' } }).success).toBe(true);
    expect(optionMapSchema.safeParse({ server: { Asia: 'Asia' } }).success).toBe(false);
    expect(optionMapSchema.safeParse({ server: { asia: '' } }).success).toBe(false);
    const options = Object.fromEntries(Array.from({ length: 51 }, (_, n) => [`o${n}`, 'x']));
    expect(optionMapSchema.safeParse({ server: options }).success).toBe(false);
    const fields = Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`f${n}`, {}]));
    expect(optionMapSchema.safeParse(fields).success).toBe(false);
  });
});

describe('pack names and amounts (rule SC13)', () => {
  it('adds the leaf name only when the packs span leaves and it is missing', () => {
    expect(suggestProductName(' 60 UC ', 'Global', true)).toBe('60 UC · Global');
    expect(suggestProductName('Global · 60 UC', 'Global', true)).toBe('Global · 60 UC');
    expect(suggestProductName('60 UC', 'Global', false)).toBe('60 UC');
    expect(suggestProductName('60 UC', ' ', true)).toBe('60 UC');
    expect(suggestProductName('x'.repeat(70), 'Leaf', true)).toHaveLength(60);
  });

  it('reads the first whole number', () => {
    expect(parseGameAmount('60 UC')).toBe(60);
    expect(parseGameAmount('1,800 UC + 300')).toBe(1800);
    expect(parseGameAmount('Steam 10 USD')).toBe(10);
    expect(parseGameAmount('Weekly pass')).toBeNull();
    expect(parseGameAmount('0 coins')).toBeNull();
    expect(parseGameAmount('99999999999 gems')).toBeNull();
  });
});

describe('discount and stock (rules SF1, SF2)', () => {
  it('discount only when the original is above the cost', () => {
    expect(discountPercent(881_000, 1_000_000)).toBe(11);
    expect(discountPercent(999_999, 1_000_000)).toBeNull();
    expect(discountPercent(1_000_000, 1_000_000)).toBeNull();
    expect(discountPercent(null, 1_000_000)).toBeNull();
    expect(discountPercent(1_000_000, null)).toBeNull();
  });

  it('levels', () => {
    expect(stockLevel(5, false, 10)).toBe('out');
    expect(stockLevel(0, true, 10)).toBe('out');
    expect(stockLevel(null, true, 10)).toBe('unlimited');
    expect(stockLevel(9, true, 10)).toBe('low');
    expect(stockLevel(10, true, 10)).toBe('ok');
  });

  it('alerts once per rise and clears on recovery', () => {
    expect(stockAlertChange(null, 'low')).toEqual({ alert: true, next: 'low' });
    expect(stockAlertChange('low', 'low')).toEqual({ alert: false, next: 'low' });
    expect(stockAlertChange('low', 'out')).toEqual({ alert: true, next: 'out' });
    expect(stockAlertChange('out', 'low')).toEqual({ alert: false, next: 'out' });
    expect(stockAlertChange('out', 'ok')).toEqual({ alert: false, next: null });
    expect(stockAlertChange(null, 'unlimited')).toEqual({ alert: false, next: null });
  });
});

describe('nearby supplier orders (rule SF4)', () => {
  const attempt = {
    supplierOfferId: '235203',
    quantity: 1,
    sentAt: new Date('2026-10-13T10:00:00Z'),
  };
  const order = { offerId: '235203', quantity: 1, createdAt: '2026-10-13T10:14:00.000Z' };

  it('same offer and quantity within 15 minutes, unknown fields allowed', () => {
    expect(isNearbySupplierOrder(order, attempt)).toBe(true);
    expect(isNearbySupplierOrder({ ...order, offerId: null, quantity: null }, attempt)).toBe(true);
    expect(
      isNearbySupplierOrder({ ...order, createdAt: '2026-10-13T10:16:00.000Z' }, attempt),
    ).toBe(false);
    expect(isNearbySupplierOrder({ ...order, offerId: '1' }, attempt)).toBe(false);
    expect(isNearbySupplierOrder({ ...order, quantity: 2 }, attempt)).toBe(false);
    // No time from the supplier: still a possible match.
    expect(isNearbySupplierOrder({ ...order, createdAt: null }, attempt)).toBe(true);
  });
});

describe('capabilities and health (S16, SF6)', () => {
  it('declares the panel reads for wdgzone and fake only', () => {
    expect(supplierPanelCapabilities('wdgzone').categories).toBe(true);
    expect(supplierPanelCapabilities('fake').statement).toBe(true);
    expect(supplierPanelCapabilities('manual')).toEqual({
      categories: false,
      statement: false,
      platformStatus: false,
    });
    expect(PANEL_READ_OPERATIONS).not.toContain('list_categories');
  });

  it('leaves category reads out of the p90', () => {
    const at = new Date('2026-10-13T10:00:00Z');
    const verdict = supplierHealth(
      Array.from({ length: 10 }, () => ({
        operation: 'list_categories' as const,
        result: 'ok' as const,
        latencyMs: 60_000,
        at,
      })),
      SUPPLIER_POLICY_DEFAULTS,
      { state: 'healthy', reason: 'x', since: new Date(0) },
      at,
    );
    expect(verdict).toMatchObject({ state: 'healthy', p90Ms: null });
  });

  it('bounds the low-stock threshold', () => {
    expect(
      supplierPolicySchema.safeParse({ ...SUPPLIER_POLICY_DEFAULTS, lowStockUnits: 0 }).success,
    ).toBe(false);
    expect(SUPPLIER_POLICY_DEFAULTS.lowStockUnits).toBe(10);
  });
});

describe('catalog request shapes', () => {
  const offerId = '0190a000-0000-7000-8000-0000000000aa';
  const game = {
    slug: 'pubg-mobile',
    categoryId: GAME,
    nameAr: 'ببجي',
    nameEn: 'PUBG Mobile',
  };

  it('an import takes each offer once', () => {
    const row = { offerId, nameAr: '60 UC' };
    const base = { game, cover: { supplierImage: true as const }, fields: [] };
    expect(importCategorySchema.safeParse({ ...base, rows: [row] }).success).toBe(true);
    expect(importCategorySchema.safeParse({ ...base, rows: [row, row] }).success).toBe(false);
  });

  it('a link mixes existing and new rows, each offer once', () => {
    const rows = [{ offerId, productId: GAME }];
    expect(linkCategorySchema.parse({ gameId: GAME, rows }).fieldMap).toEqual({});
    expect(linkCategorySchema.safeParse({ gameId: GAME, rows: [...rows, ...rows] }).success).toBe(
      false,
    );
  });

  it('pages of the tree hold up to 200 nodes', () => {
    expect(supplierCategoryListQuerySchema.parse({}).pageSize).toBe(100);
    expect(supplierCategoryListQuerySchema.safeParse({ pageSize: '201' }).success).toBe(false);
  });

  it('answers keep their shapes', () => {
    expect(
      activateAllResultSchema.safeParse({
        gameId: GAME,
        gameActivated: true,
        activated: [],
        skipped: [{ productId: GAME, nameAr: 'x', reason: 'no_route' }],
      }).success,
    ).toBe(true);
    expect(supplierOrderPageSchema.safeParse({ items: [], page: 1, hasMore: false }).success).toBe(
      true,
    );
  });
});
