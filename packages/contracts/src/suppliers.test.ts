import { describe, expect, it } from 'vitest';
import {
  chargeCheck,
  createRouteSchema,
  fieldMapSchema,
  HEALTH_PROBE_REASON,
  type HealthCall,
  type HealthStanding,
  healthReadStart,
  healthWindowStart,
  importOffersSchema,
  isCostStale,
  orderRoutes,
  priceBasis,
  probeOutcome,
  type RouteFacts,
  routeTier,
  routeTimingValid,
  routeUnusableReason,
  SUPPLIER_CODES,
  SUPPLIER_CREDENTIAL_FIELDS,
  SUPPLIER_POLICY_DEFAULTS,
  type SupplierHealthState,
  supplierAvailable,
  supplierChecksPlayers,
  supplierHasCatalog,
  supplierHealth,
  supplierPolicySchema,
  unmappedFields,
  updateSupplierSchema,
} from './suppliers.js';

const now = new Date('2026-10-08T12:00:00Z');
type FieldSpec = RouteFacts['fieldSpecs'] extends readonly (infer Spec)[] | null ? Spec : never;
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
  offerUnsupported: false,
  kindMismatch: false,
  inStock: true,
  costUsdUnits: 880_000,
  costConfirmedAt: minutesAgo(5),
  requiredFields: ['playerId'],
  fieldMap: { playerId: 'player_id' },
  optionMap: {},
  fieldSpecs: null,
  liveFieldKeys: ['player_id'],
  liveSelectOptions: {},
  balanceUsdUnits: 1_000_000_000,
};

describe('suppliers (rule SP1)', () => {
  it('are available with an adapter; fake only where enabled', () => {
    expect(supplierAvailable('manual', { fakeEnabled: false })).toBe(true);
    expect(supplierAvailable('fake', { fakeEnabled: true })).toBe(true);
    expect(supplierAvailable('fake', { fakeEnabled: false })).toBe(false);
    expect(supplierAvailable('wdgzone', { fakeEnabled: false })).toBe(true);
  });

  it('list offers except the manual supplier', () => {
    expect(SUPPLIER_CODES.filter(supplierHasCatalog)).toEqual(['wdgzone', 'fake']);
  });

  it('ask for credentials except the manual supplier', () => {
    expect(SUPPLIER_CREDENTIAL_FIELDS.manual).toEqual([]);
    expect(SUPPLIER_CREDENTIAL_FIELDS.fake).toEqual(['webhookSecret']);
    expect(SUPPLIER_CREDENTIAL_FIELDS.wdgzone).toEqual(['apiKey']);
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
      [{ offerMissing: true, offerUnsupported: true }, 'offer_missing'],
      [{ offerUnsupported: true, kindMismatch: true }, 'offer_unsupported'],
      [{ kindMismatch: true, inStock: false }, 'kind_mismatch'],
      [{ inStock: false, costUsdUnits: null }, 'out_of_stock'],
      [{ costUsdUnits: null }, 'cost_unknown'],
      [{ costConfirmedAt: minutesAgo(121) }, 'cost_stale'],
      [{ costConfirmedAt: null }, 'cost_stale'],
      [{ fieldMap: {} }, 'fields_incomplete'],
      [{ liveFieldKeys: [] }, 'fields_incomplete'],
      [
        {
          fieldSpecs: [
            { key: 'region', label: 'Region', type: 'select', options: [] },
          ] as FieldSpec[],
          fieldMap: { playerId: 'player_id', region: 'region' },
          liveFieldKeys: ['player_id', 'region'],
          liveSelectOptions: { region: ['eu'] },
        },
        'fields_incomplete',
      ],
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
    extra: { health?: 'healthy' | 'degraded'; priority?: number; priceBasis?: boolean } = {},
  ) => ({
    supplierCode,
    costUsdUnits,
    health: extra.health ?? 'healthy',
    priority: extra.priority ?? 1,
    priceBasis: extra.priceBasis ?? true,
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
      route('fake', 500, { priority: 2 }),
      route('fake', 500, { priority: 1 }),
      route('fake', 400, { priority: 9 }),
    ]);
    expect(ordered.map((item) => [item.supplierCode, item.costUsdUnits])).toEqual([
      ['fake', 400],
      ['fake', 500],
      ['fake', 500],
      ['wdgzone', 500],
      ['fake', null],
    ]);
  });

  it('bases the price on the first route, or none', () => {
    expect(priceBasis([route('manual', 100), route('fake', 900)], true)?.supplierCode).toBe('fake');
    expect(priceBasis([], true)).toBeNull();
    expect(priceBasis([], false)).toBeNull();
  });

  it('bases the price on the first route that counts, not a cheaper one (S17 WR3)', () => {
    const web = route('wdgzone', 900, { priceBasis: false });
    const auto = route('wdgzone', 1_000);
    expect(priceBasis([web, auto], true)).toBe(auto);
    expect(priceBasis([web, auto], false)).toBe(auto);
  });

  it('keeps a price with no counting route usable, else takes the first (S17 WR4)', () => {
    const web = route('wdgzone', 900, { priceBasis: false });
    const dear = route('fake', 950, { priceBasis: false });
    expect(priceBasis([dear, web], true)).toBeNull();
    expect(priceBasis([dear, web], false)).toBe(web);
  });

  it('accepts an expected time only below the hard limit (S17)', () => {
    const timing = (expected: number | null, limit: number | null) => ({
      expectedDeliveryMinutes: expected,
      hardLimitMinutes: limit,
    });
    expect(routeTimingValid(timing(null, null), 30)).toBe(true);
    expect(routeTimingValid(timing(null, 10), 30)).toBe(true);
    expect(routeTimingValid(timing(30, 45), 30)).toBe(true);
    expect(routeTimingValid(timing(45, 45), 30)).toBe(false);
    expect(routeTimingValid(timing(29, null), 30)).toBe(true);
    expect(routeTimingValid(timing(30, null), 30)).toBe(false);
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
      optionMap: {},
      priceBasis: true,
      expectedDeliveryMinutes: null,
      hardLimitMinutes: null,
    });
    expect(createRouteSchema.safeParse({ offerId: id, priority: 10 }).success).toBe(false);
    expect(createRouteSchema.safeParse({ offerId: id, hardLimitMinutes: 4 }).success).toBe(false);
    expect(createRouteSchema.safeParse({ offerId: id, expectedDeliveryMinutes: 241 }).success).toBe(
      false,
    );
  });

  it('import 1–100 offers, each once', () => {
    const row = { offerId: id, nameAr: ' 60 شدة ' };
    expect(importOffersSchema.parse({ gameId: id, rows: [row] })).toEqual({
      gameId: id,
      fieldMap: {},
      optionMap: {},
      rows: [{ offerId: id, nameAr: '60 شدة' }],
    });
    expect(importOffersSchema.safeParse({ gameId: id, rows: [row, row] }).success).toBe(false);
    expect(importOffersSchema.safeParse({ gameId: id, rows: [] }).success).toBe(false);
  });
});

describe('supplierHealth (rules H1, H2; S18 HE1–HE3)', () => {
  const P = SUPPLIER_POLICY_DEFAULTS;
  const standing = (state: SupplierHealthState, reason = 'x'): HealthStanding => ({
    state,
    reason,
    since: minutesAgo(60),
  });
  const healthy = standing('healthy');
  const degraded = standing('degraded', 'success 80% < 90%');
  const call = (
    result: HealthCall['result'],
    latencyMs = 500,
    operation: HealthCall['operation'] = 'get_balance',
    at = now,
  ): HealthCall => ({ operation, result, latencyMs, at });
  const calls = (ok: number, errors: number, refused = 0) => [
    ...Array.from({ length: errors }, () => call('error')),
    ...Array.from({ length: refused }, () => call('refused')),
    ...Array.from({ length: ok }, () => call('ok')),
  ];
  /** `count` calls one a minute from `from` minutes ago. */
  const spread = (count: number, from: number, result: HealthCall['result'] = 'ok') =>
    Array.from({ length: count }, (_, index) =>
      call(result, 500, 'get_balance', minutesAgo(from + index)),
    );

  it('is healthy with enough answered calls; a refusal counts as answered', () => {
    expect(supplierHealth(calls(9, 0, 1), P, healthy, now)).toEqual({
      state: 'healthy',
      reason: 'success 100%',
      calls: 10,
      successBp: 10_000,
      p90Ms: 500,
    });
    expect(supplierHealth(calls(9, 1), P, healthy, now)).toMatchObject({
      state: 'healthy',
      successBp: 9_000,
    });
  });

  it('does not flap on one error as calls enter and leave the window (2026-10-19)', () => {
    // 8 of 9 answered was `degraded` at a minimum of 5; below 10 calls the state now stays.
    expect(supplierHealth(calls(8, 1), P, healthy, now)).toMatchObject({
      state: 'healthy',
      reason: '9 calls < 10',
      successBp: 8_888,
    });
    expect(supplierHealth(calls(7, 1), P, healthy, now)).toMatchObject({ state: 'healthy' });
  });

  it('is degraded below 90% success or above the p90 limit', () => {
    expect(supplierHealth(calls(8, 2), P, healthy, now)).toMatchObject({
      state: 'degraded',
      reason: 'success 80% < 90%',
      successBp: 8_000,
    });
    const slow = [
      ...Array.from({ length: 8 }, () => call('ok', 400)),
      call('ok', 12_000),
      call('ok', 15_000),
    ];
    expect(supplierHealth(slow, P, healthy, now)).toMatchObject({
      state: 'degraded',
      reason: 'p90 12000 ms > 10000 ms',
      p90Ms: 12_000,
    });
    // At the limit exactly, and a slow catalog read does not count (rule H1).
    expect(
      supplierHealth(
        [...calls(8, 0), call('ok', 10_000), call('ok', 10_000), call('ok', 60_000, 'list_offers')],
        P,
        healthy,
        now,
      ),
    ).toMatchObject({ state: 'healthy', p90Ms: 10_000 });
    expect(
      supplierHealth([call('ok', 60_000, 'list_offers'), ...calls(9, 0)], P, healthy, now),
    ).toMatchObject({ state: 'healthy', calls: 10, p90Ms: 500 });
  });

  it('is down below 50% success, or after consecutive errors of two operations or more', () => {
    const mixed = (...results: HealthCall['result'][]) => results.map((result) => call(result));
    // Never 3 errors in a row: exactly 50% is degraded, not down.
    expect(
      supplierHealth(
        mixed('error', 'ok', 'error', 'ok', 'error', 'ok', 'error', 'ok', 'error', 'ok'),
        P,
        healthy,
        now,
      ),
    ).toMatchObject({ state: 'degraded', reason: 'success 50% < 90%', successBp: 5_000 });
    expect(
      supplierHealth(
        mixed('error', 'error', 'ok', 'error', 'error', 'ok', 'error', 'error', 'ok', 'ok'),
        P,
        healthy,
        now,
      ),
    ).toMatchObject({ state: 'down', reason: 'success 40% < 50%', successBp: 4_000 });
    const outage = [
      call('error', 15_000, 'get_balance'),
      call('error', 15_000, 'list_offers'),
      call('error', 15_000, 'get_order'),
    ];
    expect(supplierHealth([...calls(10, 0), ...outage], P, healthy, now)).toMatchObject({
      state: 'down',
      reason: '3 consecutive errors',
      calls: 13,
    });
  });

  it('is never down from one stuck attempt polls alone (HE3)', () => {
    const polls = Array.from({ length: 3 }, () => call('error', 15_000, 'get_order'));
    expect(supplierHealth([...calls(10, 0), ...polls], P, healthy, now)).toMatchObject({
      state: 'degraded',
      reason: 'success 76% < 90%',
    });
    expect(supplierHealth(polls, P, healthy, now)).toMatchObject({ state: 'healthy' });
  });

  it('keeps its state below the minimum count unless errors run (edge case 15)', () => {
    expect(supplierHealth([], P, degraded, now)).toEqual({
      state: 'degraded',
      reason: '0 calls < 10',
      calls: 0,
      successBp: null,
      p90Ms: null,
    });
    expect(supplierHealth([call('error')], P, healthy, now)).toMatchObject({
      state: 'healthy',
      reason: '1 calls < 10',
      successBp: 0,
    });
    expect(
      supplierHealth(
        [call('error'), call('error', 500, 'list_offers')],
        { ...P, downConsecutiveErrors: 2 },
        healthy,
        now,
      ),
    ).toMatchObject({ state: 'down', reason: '2 consecutive errors' });
  });

  it('recovers only at 95% held for 5 whole minutes (HE2)', () => {
    expect(supplierHealth(spread(12, 10), P, degraded, now)).toMatchObject({
      state: 'healthy',
      reason: 'success 100%',
      calls: 12,
    });
    // 95% exactly recovers; 94.7% does not.
    expect(
      supplierHealth([...spread(19, 10), ...spread(1, 6, 'error')], P, degraded, now),
    ).toMatchObject({ state: 'healthy', successBp: 9_500 });
    expect(
      supplierHealth([...spread(18, 10), ...spread(1, 6, 'error')], P, degraded, now),
    ).toMatchObject({ state: 'degraded', reason: 'recovering: success 94% < 95%' });
    // Calls made just now: the windows a minute ago have none yet.
    expect(supplierHealth(calls(12, 0), P, degraded, now)).toMatchObject({
      state: 'degraded',
      reason: 'recovering: held 1 of 5 minutes',
    });
    // An error that left the window 90 seconds ago is still in the window two minutes back.
    const leftWindow = call('error', 500, 'get_balance', minutesAgo(31.5));
    expect(supplierHealth([leftWindow, ...spread(12, 5)], P, degraded, now)).toMatchObject({
      state: 'degraded',
      reason: 'recovering: held 2 of 5 minutes',
    });
    // So is a slow p90.
    const slowBefore = [
      call('ok', 15_000, 'get_balance', minutesAgo(31.5)),
      call('ok', 15_000, 'get_balance', minutesAgo(31.5)),
    ];
    expect(supplierHealth([...slowBefore, ...spread(12, 5)], P, degraded, now)).toMatchObject({
      state: 'degraded',
      reason: 'recovering: held 2 of 5 minutes',
    });
    // Catalog reads only: no p90, and the recovery holds.
    const reads = Array.from({ length: 12 }, (_, index) =>
      call('ok', 60_000, 'list_categories', minutesAgo(10 + index)),
    );
    expect(supplierHealth(reads, P, degraded, now)).toMatchObject({
      state: 'healthy',
      p90Ms: null,
    });
  });

  it('reads the calls the recovery check needs', () => {
    expect(healthReadStart(healthy, now, P)).toEqual(minutesAgo(34));
    expect(
      healthReadStart(
        { state: 'degraded', reason: HEALTH_PROBE_REASON, since: minutesAgo(5) },
        now,
        P,
      ),
    ).toEqual(minutesAgo(5));
  });

  it('refuses a recovery threshold below the degraded one', () => {
    expect(supplierPolicySchema.safeParse({ ...P, recoverSuccessBp: 8_999 }).success).toBe(false);
    expect(supplierPolicySchema.safeParse({ ...P, recoverSuccessBp: 9_000 }).success).toBe(true);
  });
});

describe('probes (rule H3)', () => {
  const P = SUPPLIER_POLICY_DEFAULTS;
  const downSince = minutesAgo(30);
  const at = (minutesAfterDown: number) =>
    new Date(downSince.getTime() + minutesAfterDown * 60_000);

  it('waits, then the first call is the probe', () => {
    expect(probeOutcome(downSince, [], P)).toEqual({ recoveredAt: null, nextProbeAt: at(10) });
    // A success inside the wait counts for nothing.
    expect(probeOutcome(downSince, [{ result: 'ok', at: at(4) }], P)).toEqual({
      recoveredAt: null,
      nextProbeAt: at(10),
    });
    expect(
      probeOutcome(
        downSince,
        [
          { result: 'ok', at: at(4) },
          { result: 'refused', at: at(11) },
        ],
        P,
      ),
    ).toEqual({ recoveredAt: at(11), nextProbeAt: at(10) });
  });

  it('waits again after a failed probe', () => {
    expect(
      probeOutcome(
        downSince,
        [
          { result: 'error', at: at(10) },
          { result: 'ok', at: at(15) },
        ],
        P,
      ),
    ).toEqual({ recoveredAt: null, nextProbeAt: at(20) });
    expect(
      probeOutcome(
        downSince,
        [
          { result: 'error', at: at(10) },
          { result: 'ok', at: at(20) },
        ],
        P,
      ),
    ).toEqual({ recoveredAt: at(20), nextProbeAt: at(20) });
  });

  it('reads only the calls since a probe while its degraded state stands', () => {
    const window = minutesAgo(30);
    expect(
      healthWindowStart({ state: 'healthy', reason: 'x', since: minutesAgo(5) }, now, P),
    ).toEqual(window);
    expect(
      healthWindowStart(
        { state: 'degraded', reason: HEALTH_PROBE_REASON, since: minutesAgo(5) },
        now,
        P,
      ),
    ).toEqual(minutesAgo(5));
    expect(
      healthWindowStart(
        { state: 'degraded', reason: HEALTH_PROBE_REASON, since: minutesAgo(50) },
        now,
        P,
      ),
    ).toEqual(window);
    expect(
      healthWindowStart(
        { state: 'degraded', reason: 'success 80% < 90%', since: minutesAgo(5) },
        now,
        P,
      ),
    ).toEqual(window);
  });
});

describe('supplierChecksPlayers (S09 rule PV1)', () => {
  it('knows the adapters that check player ids in this build', () => {
    expect(supplierChecksPlayers('fake', { fakeEnabled: true })).toBe(true);
    expect(supplierChecksPlayers('fake', { fakeEnabled: false })).toBe(false);
    expect(supplierChecksPlayers('wdgzone', { fakeEnabled: true })).toBe(false);
  });
});

describe('chargeCheck (S18 CH2, RC2)', () => {
  it('compares a charge with the cost of the units delivered, within 2%', () => {
    expect(chargeCheck({ unitCostUsdUnits: 880_000, units: 1, chargedUsdUnits: 880_000 })).toEqual({
      expectedUsdUnits: 880_000,
      mismatch: false,
      unitChargedUsdUnits: 880_000,
    });
    // 2% exactly is no mismatch; above it is, either way.
    expect(
      chargeCheck({ unitCostUsdUnits: 1_000_000, units: 2, chargedUsdUnits: 2_040_000 }).mismatch,
    ).toBe(false);
    expect(
      chargeCheck({ unitCostUsdUnits: 1_000_000, units: 2, chargedUsdUnits: 2_040_001 }).mismatch,
    ).toBe(true);
    expect(
      chargeCheck({ unitCostUsdUnits: 1_000_000, units: 2, chargedUsdUnits: 1_959_999 }).mismatch,
    ).toBe(true);
    // A partial delivery charged for its units is no mismatch.
    expect(
      chargeCheck({ unitCostUsdUnits: 1_000_000, units: 2, chargedUsdUnits: 2_000_000 }),
    ).toEqual({ expectedUsdUnits: 2_000_000, mismatch: false, unitChargedUsdUnits: 1_000_000 });
  });

  it('rounds the charged unit cost up, and counts no units as one', () => {
    expect(
      chargeCheck({ unitCostUsdUnits: 1, units: 3, chargedUsdUnits: 10 }).unitChargedUsdUnits,
    ).toBe(4);
    expect(chargeCheck({ unitCostUsdUnits: 5, units: 0, chargedUsdUnits: 5 })).toMatchObject({
      expectedUsdUnits: 5,
      mismatch: false,
    });
  });
});
