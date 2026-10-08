import { describe, expect, it } from 'vitest';
import {
  createRouteSchema,
  fieldMapSchema,
  importOffersSchema,
  isCostStale,
  orderRoutes,
  priceBasis,
  type RouteFacts,
  routeTier,
  routeUnusableReason,
  SUPPLIER_CODES,
  SUPPLIER_CREDENTIAL_FIELDS,
  SUPPLIER_POLICY_DEFAULTS,
  supplierAvailable,
  supplierHasCatalog,
  supplierPolicySchema,
  unmappedFields,
  updateSupplierSchema,
} from './suppliers.js';

const now = new Date('2026-10-08T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const policy = { costStaleMinutes: 120 };
const id = '0199a000-0000-7000-8000-000000000001';

const usable: RouteFacts = {
  archived: false,
  enabled: true,
  supplierCode: 'fake',
  supplierAvailable: true,
  supplierConfigured: true,
  supplierPaused: false,
  health: 'healthy',
  offerMissing: false,
  inStock: true,
  costUsdUnits: 880_000,
  costConfirmedAt: minutesAgo(5),
  requiredFields: ['playerId'],
  fieldMap: { playerId: 'player_id' },
  liveFieldKeys: ['player_id'],
  balanceUsdUnits: 1_000_000_000,
};

describe('suppliers (rule SP1)', () => {
  it('are available with an adapter; fake only where enabled', () => {
    expect(supplierAvailable('manual', { fakeEnabled: false })).toBe(true);
    expect(supplierAvailable('fake', { fakeEnabled: true })).toBe(true);
    expect(supplierAvailable('fake', { fakeEnabled: false })).toBe(false);
    expect(supplierAvailable('shop2topup', { fakeEnabled: true })).toBe(false);
    expect(supplierAvailable('wdgzone', { fakeEnabled: true })).toBe(false);
  });

  it('list offers except the manual supplier', () => {
    expect(SUPPLIER_CODES.filter(supplierHasCatalog)).toEqual(['shop2topup', 'wdgzone', 'fake']);
  });

  it('ask for credentials except the manual supplier', () => {
    expect(SUPPLIER_CREDENTIAL_FIELDS.manual).toEqual([]);
    expect(SUPPLIER_CREDENTIAL_FIELDS.fake).toEqual(['webhookSecret']);
  });

  it('take a low-balance threshold of whole cents up to $100,000', () => {
    expect(updateSupplierSchema.safeParse({ lowBalanceUsdUnits: 0 }).success).toBe(true);
    expect(updateSupplierSchema.safeParse({ lowBalanceUsdUnits: 100_000_000_000 }).success).toBe(
      true,
    );
    expect(updateSupplierSchema.safeParse({ lowBalanceUsdUnits: 100_000_010_000 }).success).toBe(
      false,
    );
    expect(updateSupplierSchema.safeParse({ lowBalanceUsdUnits: 5_000 }).success).toBe(false);
  });
});

describe('the supplier policy', () => {
  it('accepts its defaults and keeps down below degraded', () => {
    expect(supplierPolicySchema.parse(SUPPLIER_POLICY_DEFAULTS)).toEqual(SUPPLIER_POLICY_DEFAULTS);
    expect(
      supplierPolicySchema.safeParse({ ...SUPPLIER_POLICY_DEFAULTS, downSuccessBp: 9_000 }).success,
    ).toBe(false);
    expect(
      supplierPolicySchema.safeParse({ ...SUPPLIER_POLICY_DEFAULTS, costStaleMinutes: 29 }).success,
    ).toBe(false);
  });
});

describe('routeUnusableReason (rule RT4)', () => {
  it('accepts a usable route', () => {
    expect(routeUnusableReason(usable, now, policy)).toBeNull();
  });

  it('names each reason in order', () => {
    const cases: [Partial<RouteFacts>, string][] = [
      [{ archived: true, enabled: false }, 'archived'],
      [{ enabled: false, supplierAvailable: false }, 'disabled'],
      [{ supplierAvailable: false, supplierConfigured: false }, 'supplier_unavailable'],
      [{ supplierConfigured: false, supplierPaused: true }, 'supplier_not_configured'],
      [{ supplierPaused: true, health: 'down' }, 'supplier_paused'],
      [{ health: 'down', offerMissing: true }, 'supplier_down'],
      [{ offerMissing: true, inStock: false }, 'offer_missing'],
      [{ inStock: false, costUsdUnits: null }, 'out_of_stock'],
      [{ costUsdUnits: null }, 'cost_unknown'],
      [{ costConfirmedAt: minutesAgo(121) }, 'cost_stale'],
      [{ costConfirmedAt: null }, 'cost_stale'],
      [{ fieldMap: {} }, 'fields_incomplete'],
      [{ liveFieldKeys: [] }, 'fields_incomplete'],
      [{ balanceUsdUnits: 879_999 }, 'balance_low'],
    ];
    for (const [change, reason] of cases) {
      expect(routeUnusableReason({ ...usable, ...change }, now, policy)).toBe(reason);
    }
  });

  it('keeps a degraded supplier, an exact balance, unknown requirements and a 2-hour cost', () => {
    for (const change of [
      { health: 'degraded' as const },
      { balanceUsdUnits: 880_000 },
      { balanceUsdUnits: null },
      { requiredFields: null, fieldMap: {} },
      { costConfirmedAt: minutesAgo(120) },
    ]) {
      expect(routeUnusableReason({ ...usable, ...change }, now, policy)).toBeNull();
    }
  });

  it('never makes a manual cost stale', () => {
    const manual = { ...usable, supplierCode: 'manual' as const, costConfirmedAt: null };
    expect(routeUnusableReason(manual, now, policy)).toBeNull();
    expect(isCostStale('manual', minutesAgo(10_000), now, policy)).toBe(false);
  });

  it('lists the supplier fields left unmapped (rule RT3)', () => {
    expect(unmappedFields(['playerId', 'zoneId'], { playerId: 'player_id' })).toEqual(['zoneId']);
    expect(unmappedFields(null, {})).toEqual([]);
  });
});

describe('route order and basis (rules RT5, RT6, P1)', () => {
  const route = (
    supplierCode: (typeof SUPPLIER_CODES)[number],
    costUsdUnits: number | null,
    extra: { health?: 'healthy' | 'degraded'; priority?: number } = {},
  ) => ({
    supplierCode,
    costUsdUnits,
    health: extra.health ?? 'healthy',
    priority: extra.priority ?? 1,
  });

  it('puts healthy, then degraded, then manual routes first, whatever the cost', () => {
    const ordered = orderRoutes([
      route('manual', 100),
      route('wdgzone', 500, { health: 'degraded' }),
      route('fake', 900),
    ]);
    expect(ordered.map((item) => item.supplierCode)).toEqual(['fake', 'wdgzone', 'manual']);
    expect(routeTier('manual', 'healthy')).toBe('manual');
    expect(routeTier('fake', 'down')).toBe('degraded');
  });

  it('breaks ties by cost, then priority, then supplier code; unknown costs last', () => {
    const ordered = orderRoutes([
      route('wdgzone', 500, { priority: 2 }),
      route('fake', null),
      route('shop2topup', 500, { priority: 2 }),
      route('fake', 500, { priority: 1 }),
      route('fake', 400, { priority: 9 }),
    ]);
    expect(ordered.map((item) => [item.supplierCode, item.costUsdUnits])).toEqual([
      ['fake', 400],
      ['fake', 500],
      ['shop2topup', 500],
      ['wdgzone', 500],
      ['fake', null],
    ]);
  });

  it('bases the price on the first route, or none', () => {
    expect(priceBasis([route('manual', 100), route('fake', 900)])?.supplierCode).toBe('fake');
    expect(priceBasis([])).toBeNull();
  });
});

describe('route inputs', () => {
  it('bound the field map to 10 entries of valid names', () => {
    expect(fieldMapSchema.safeParse({ playerId: 'player_id' }).success).toBe(true);
    expect(fieldMapSchema.safeParse({ playerId: 'Player' }).success).toBe(false);
    const eleven = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`field${index}`, 'player_id']),
    );
    expect(fieldMapSchema.safeParse(eleven).success).toBe(false);
  });

  it('default a route to priority 1 and an empty map', () => {
    expect(createRouteSchema.parse({ offerId: id })).toEqual({
      offerId: id,
      priority: 1,
      fieldMap: {},
    });
    expect(createRouteSchema.safeParse({ offerId: id, priority: 10 }).success).toBe(false);
  });

  it('import 1–100 offers, each once', () => {
    const row = { offerId: id, nameAr: ' 60 شدة ' };
    expect(importOffersSchema.parse({ gameId: id, rows: [row] })).toEqual({
      gameId: id,
      fieldMap: {},
      rows: [{ offerId: id, nameAr: '60 شدة' }],
    });
    expect(importOffersSchema.safeParse({ gameId: id, rows: [row, row] }).success).toBe(false);
    expect(importOffersSchema.safeParse({ gameId: id, rows: [] }).success).toBe(false);
  });
});
