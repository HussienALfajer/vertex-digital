import { z } from 'zod';
import {
  createGameSchema,
  createInputFieldSchema,
  inputFieldTypeSchema,
  MAX_INPUT_FIELDS_PER_GAME,
  productAvailabilitySchema,
  productKindSchema,
  type SelectOption,
  type StockLevel,
  selectOptionSchema,
  stockLevelSchema,
} from './catalog.js';
import { pagedListSchema, pageQuerySchema } from './lists.js';
import { CURRENCY_SCALE, currencySchema, USD_CENT, usdCentsSchema } from './money.js';

/*
 * Suppliers, their offers and the routes that map store products to offers (S07, F09; ADR 0005,
 * 0021), owned by the api `suppliers` module. Costs are USD units; the price math is in
 * `pricing.ts`. Supplier text (offer names, groups) is shown as received, as text only.
 */

/** ADR 0031: WDGZone is the only automatic supplier. */
export const SUPPLIER_CODES = ['wdgzone', 'manual', 'fake'] as const;

export const supplierCodeSchema = z.enum(SUPPLIER_CODES).meta({ id: 'SupplierCode' });

export type SupplierCode = z.infer<typeof supplierCodeSchema>;

export const SUPPLIER_HEALTH_STATES = ['healthy', 'degraded', 'down'] as const;

export const supplierHealthStateSchema = z
  .enum(SUPPLIER_HEALTH_STATES)
  .meta({ id: 'SupplierHealthState' });

export type SupplierHealthState = z.infer<typeof supplierHealthStateSchema>;

/** The adapter calls recorded in `supplier_calls`, which health is computed from (rule H1). */
export const SUPPLIER_CALL_OPERATIONS = [
  'list_offers',
  'get_balance',
  'validate_player',
  'place_order',
  'get_order',
  /** S16 SC2: the category tree, read by the sync before the offers. */
  'list_categories',
  /** S16 SF3–SF5, IM1–IM3: the panel's live reads, recorded but left out of health (SF6). */
  'list_transactions',
  'list_orders',
  'platform_status',
  'fetch_image',
] as const;

/** S16 SF6: calls the panel makes on request; health counts the operations orders depend on. */
export const PANEL_READ_OPERATIONS: readonly SupplierCallOperation[] = [
  'list_transactions',
  'list_orders',
  'platform_status',
  'fetch_image',
];

/**
 * `ok`: answered; `refused`: a definitive refusal (the supplier is working); `error`: no
 * trustworthy answer (timeout, connection, 5xx, unreadable reply, an `unknown` order outcome).
 */
export const SUPPLIER_CALL_RESULTS = ['ok', 'refused', 'error'] as const;

export type SupplierCallOperation = (typeof SUPPLIER_CALL_OPERATIONS)[number];

export type SupplierCallResult = (typeof SUPPLIER_CALL_RESULTS)[number];

/**
 * The secret fields the panel asks for, per supplier (rule SP2). WDGZone signs its webhooks with a
 * secret derived from the API key, so the key is its only field (docs/suppliers/wdgzone.md).
 */
export const SUPPLIER_CREDENTIAL_FIELDS: Record<SupplierCode, readonly string[]> = {
  wdgzone: ['apiKey'],
  manual: [],
  fake: ['webhookSecret'],
};

/**
 * Suppliers whose adapter this build has (rule SP1). `manual` needs none; `fake` counts only where
 * `SUPPLIER_FAKE_ENABLED=true`. Each real adapter's PR adds its code here.
 */
const ADAPTERS_READY: readonly SupplierCode[] = ['wdgzone', 'manual', 'fake'];

/** Rule SP1: the running app has this supplier's adapter. */
export function supplierAvailable(code: SupplierCode, options: { fakeEnabled: boolean }): boolean {
  if (code === 'fake' && !options.fakeEnabled) return false;
  return ADAPTERS_READY.includes(code);
}

/** Suppliers that list offers (rule SY1); `manual` offers are the admin's. */
/**
 * S09 rule PV1: this build has an adapter for the supplier that checks player ids. Each real
 * adapter's PR adds its code.
 */
export function supplierChecksPlayers(
  code: SupplierCode,
  options: { fakeEnabled: boolean },
): boolean {
  return code === 'fake' && supplierAvailable(code, options);
}

export function supplierHasCatalog(code: SupplierCode): boolean {
  return code !== 'manual';
}

export const SYNC_RUN_TRIGGERS = ['schedule', 'admin'] as const;

export const syncRunTriggerSchema = z.enum(SYNC_RUN_TRIGGERS).meta({ id: 'SyncRunTrigger' });

export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

export const syncRunStatusSchema = z.enum(SYNC_RUN_STATUSES).meta({ id: 'SyncRunStatus' });

/** Every cost is above zero and at most $10,000. */
export const SUPPLIER_COST_MAX_USD_UNITS = 10_000 * CURRENCY_SCALE.USD;

/** A supplier's low-balance threshold (A07): whole cents, $0–$100,000, $50 by default. */
export const LOW_BALANCE_MAX_USD_UNITS = 100_000 * CURRENCY_SCALE.USD;
export const LOW_BALANCE_DEFAULT_USD_UNITS = 50 * CURRENCY_SCALE.USD;

/** "Sync now" at most once a minute per supplier (S07 "Access"). */
export const SYNC_REQUEST_INTERVAL_SECONDS = 60;

/** An import takes 1–100 offers (rule RT8); a field map at most 10 entries. */
/** Failed sync runs in a row before the admin is told (S07 "Jobs and integrations", S11 DB6). */
export const FAILING_SYNC_RUNS = 3;

export const MAX_IMPORT_ROWS = 100;
export const MAX_FIELD_MAP_ENTRIES = 10;

/** A route's priority: 1–9, a tie-break only (rule RT6). */
export const ROUTE_PRIORITY_MAX = 9;

// Policy ----------------------------------------------------------------------------------------

/** The supplier policy (ADR 0021): the newest `supplier_policy` row is in force. */
export const supplierPolicySchema = z
  .object({
    priceReviewThresholdBp: z.int().min(100).max(5_000),
    costStaleMinutes: z.int().min(30).max(1_440),
    healthWindowMinutes: z.int().min(5).max(240),
    healthMinCalls: z.int().min(1).max(100),
    degradedSuccessBp: z.int().min(1).max(10_000),
    degradedP90Ms: z.int().min(1_000).max(120_000),
    downSuccessBp: z.int().min(0).max(9_999),
    downConsecutiveErrors: z.int().min(1).max(20),
    probeAfterMinutes: z.int().min(1).max(120),
    /** S16 SF2: a mapped offer's reported stock below this is low (owner, 2026-10-12: 10). */
    lowStockUnits: z.int().min(1).max(1_000),
  })
  .refine((policy) => policy.downSuccessBp < policy.degradedSuccessBp, {
    message: 'Expected downSuccessBp below degradedSuccessBp',
    path: ['downSuccessBp'],
  })
  .meta({ id: 'SupplierPolicy' });

export type SupplierPolicy = z.infer<typeof supplierPolicySchema>;

/** The seeded policy (ADR 0021). */
export const SUPPLIER_POLICY_DEFAULTS: SupplierPolicy = {
  priceReviewThresholdBp: 1_000,
  costStaleMinutes: 120,
  healthWindowMinutes: 30,
  healthMinCalls: 5,
  degradedSuccessBp: 9_000,
  degradedP90Ms: 10_000,
  downSuccessBp: 5_000,
  downConsecutiveErrors: 3,
  probeAfterMinutes: 10,
  lowStockUnits: 10,
};

// Health (H1–H3) -------------------------------------------------------------------------------

/** One recorded adapter call (`supplier_calls`), as health reads it. */
export interface HealthCall {
  operation: SupplierCallOperation;
  result: SupplierCallResult;
  latencyMs: number;
  at: Date;
}

/** A supplier's state: its newest `supplier_health_changes` row (none: `healthy`). */
export interface HealthStanding {
  state: SupplierHealthState;
  reason: string;
  since: Date;
}

export interface HealthVerdict {
  state: SupplierHealthState;
  reason: string;
  /** The window's figures; null when the verdict did not read them (a probe). */
  calls: number | null;
  successBp: number | null;
  p90Ms: number | null;
}

/** The reason of the `degraded` state a successful probe gives (rule H3). */
export const HEALTH_PROBE_REASON = 'probe ok';

const percent = (bp: number) => `${Math.floor(bp / 100)}%`;

/**
 * The first call time health reads (rules H1, H3): the window's start, or, while a probe's
 * `degraded` stands, the probe's time, so only the calls since it can make the supplier healthy.
 */
export function healthWindowStart(
  previous: HealthStanding,
  now: Date,
  policy: Pick<SupplierPolicy, 'healthWindowMinutes'>,
): Date {
  const start = new Date(now.getTime() - policy.healthWindowMinutes * 60_000);
  const sinceProbe = previous.state === 'degraded' && previous.reason === HEALTH_PROBE_REASON;
  return sinceProbe && previous.since > start ? previous.since : start;
}

/**
 * Rules H1 and H2 over the calls since `healthWindowStart`, oldest first: `down` after
 * `downConsecutiveErrors` errors in a row or, with at least `healthMinCalls` calls, a success rate
 * below `downSuccessBp`; `degraded` below `degradedSuccessBp` or above `degradedP90Ms` (p90 of
 * every operation but `list_offers`); else `healthy`. With fewer calls and no run of errors, the
 * state stays. A `down` supplier leaves that state only by a probe (`probeOutcome`, rule H3).
 */
export function supplierHealth(
  calls: readonly HealthCall[],
  policy: SupplierPolicy,
  previous: SupplierHealthState,
): HealthVerdict {
  const total = calls.length;
  const answered = calls.filter((call) => call.result !== 'error').length;
  const successBp = total === 0 ? null : Math.floor((answered * 10_000) / total);
  const latencies = calls
    .filter((call) => call.operation !== 'list_offers' && call.operation !== 'list_categories')
    .map((call) => call.latencyMs)
    .sort((a, b) => a - b);
  // Nearest rank: the smallest latency at or above 90% of the calls.
  const p90Ms =
    latencies.length === 0
      ? null
      : (latencies[Math.ceil((latencies.length * 9) / 10) - 1] as number);
  const figures = { calls: total, successBp, p90Ms };
  const run = calls.slice(-policy.downConsecutiveErrors);
  if (run.length === policy.downConsecutiveErrors && run.every((call) => call.result === 'error')) {
    return { state: 'down', reason: `${run.length} consecutive errors`, ...figures };
  }
  if (successBp === null || total < policy.healthMinCalls) {
    return { state: previous, reason: `${total} calls < ${policy.healthMinCalls}`, ...figures };
  }
  if (successBp < policy.downSuccessBp) {
    return {
      state: 'down',
      reason: `success ${percent(successBp)} < ${percent(policy.downSuccessBp)}`,
      ...figures,
    };
  }
  if (successBp < policy.degradedSuccessBp) {
    return {
      state: 'degraded',
      reason: `success ${percent(successBp)} < ${percent(policy.degradedSuccessBp)}`,
      ...figures,
    };
  }
  if (p90Ms !== null && p90Ms > policy.degradedP90Ms) {
    return {
      state: 'degraded',
      reason: `p90 ${p90Ms} ms > ${policy.degradedP90Ms} ms`,
      ...figures,
    };
  }
  return { state: 'healthy', reason: `success ${percent(successBp)}`, ...figures };
}

/**
 * Rule H3 for a supplier `down` since `downSince`, over its calls since then, oldest first: the
 * first call `probeAfterMinutes` after entering `down` (or after the last failed probe) is the
 * probe; its success recovers the supplier (to `degraded`), its failure starts the wait again.
 * Calls inside a wait count for nothing. `nextProbeAt` is when the job probes, if nothing has.
 */
export function probeOutcome(
  downSince: Date,
  calls: readonly Pick<HealthCall, 'result' | 'at'>[],
  policy: Pick<SupplierPolicy, 'probeAfterMinutes'>,
): { recoveredAt: Date | null; nextProbeAt: Date } {
  const wait = policy.probeAfterMinutes * 60_000;
  let nextProbeAt = new Date(downSince.getTime() + wait);
  for (const call of calls) {
    if (call.at < nextProbeAt) continue;
    if (call.result !== 'error') return { recoveredAt: call.at, nextProbeAt };
    nextProbeAt = new Date(call.at.getTime() + wait);
  }
  return { recoveredAt: null, nextProbeAt };
}

// Routes (RT3–RT6) ------------------------------------------------------------------------------

/** Why a route cannot serve its product now (rule RT4), in the order they are checked. */
export const ROUTE_UNUSABLE_REASONS = [
  'archived',
  'disabled',
  'supplier_unavailable',
  'supplier_not_configured',
  'supplier_paused',
  'supplier_down',
  'offer_missing',
  /** S16 SC3: the offer has fields its adapter cannot send (MF1, MF2). */
  'offer_unsupported',
  'out_of_stock',
  'cost_unknown',
  'cost_stale',
  'fields_incomplete',
  'balance_low',
] as const;

export const routeUnusableReasonSchema = z
  .enum(ROUTE_UNUSABLE_REASONS)
  .meta({ id: 'RouteUnusableReason' });

export type RouteUnusableReason = z.infer<typeof routeUnusableReasonSchema>;

/** Healthy automatic routes, then degraded automatic routes, then the manual route (rule RT5). */
export const ROUTE_TIERS = ['healthy', 'degraded', 'manual'] as const;

export const routeTierSchema = z.enum(ROUTE_TIERS).meta({ id: 'RouteTier' });

export type RouteTier = z.infer<typeof routeTierSchema>;

/** What rule RT4 reads about a route, its supplier, its offer and its product's game. */
export interface RouteFacts {
  archived: boolean;
  enabled: boolean;
  supplierCode: SupplierCode;
  supplierAvailable: boolean;
  supplierConfigured: boolean;
  supplierPaused: boolean;
  health: SupplierHealthState;
  offerMissing: boolean;
  /** S16 SC3: the offer has an `unsupported_reason`. */
  offerUnsupported: boolean;
  inStock: boolean;
  costUsdUnits: number | null;
  costConfirmedAt: Date | null;
  /** The supplier's field names; null when it does not publish them. */
  requiredFields: readonly string[] | null;
  /** Supplier field name → input field key. */
  fieldMap: Readonly<Record<string, string>>;
  /** S16 MF2: supplier field name → our option value → the supplier's option value. */
  optionMap: OptionMap;
  /** S16 MF2: the offer's field specs (its select options); null when unknown. */
  fieldSpecs: readonly FieldSpec[] | null;
  /** The unarchived input field keys of the product's game. */
  liveFieldKeys: readonly string[];
  /** S16 MF2: the option values of the game's unarchived `select` fields, by key. */
  liveSelectOptions: Readonly<Record<string, readonly string[]>>;
  /** The supplier's newest balance in USD units; null when it reports none in USD. */
  balanceUsdUnits: number | null;
}

/** The supplier fields a route leaves unmapped (rule RT3); empty when they are unknown. */
export function unmappedFields(
  requiredFields: readonly string[] | null,
  fieldMap: Readonly<Record<string, string>>,
): string[] {
  return (requiredFields ?? []).filter((field) => !Object.hasOwn(fieldMap, field));
}

/**
 * S16 MF2, MF3 (RT3 extended): the supplier `select` fields a route cannot send from every option
 * of the field they map to. A supplier select must map to one of our `select` fields, and the
 * option map must give each of that field's options a value from the supplier's own list. Our
 * select mapped to a supplier text field sends our option value as it is. Empty when the
 * supplier's fields are unknown.
 */
export function unmappedOptions(
  fieldSpecs: readonly FieldSpec[] | null,
  fieldMap: Readonly<Record<string, string>>,
  optionMap: OptionMap,
  selectOptions: Readonly<Record<string, readonly string[]>>,
): string[] {
  return (fieldSpecs ?? []).flatMap((spec) => {
    if (spec.type !== 'select' || !Object.hasOwn(fieldMap, spec.key)) return [];
    const ours = selectOptions[fieldMap[spec.key] as string];
    if (!ours) return [spec.key];
    const theirs = new Set((spec.options ?? []).map((option) => option.value));
    const values = Object.hasOwn(optionMap, spec.key) ? optionMap[spec.key] : undefined;
    const complete = ours.every((value) => {
      const sent = values && Object.hasOwn(values, value) ? values[value] : undefined;
      return sent !== undefined && theirs.has(sent);
    });
    return complete ? [] : [spec.key];
  });
}

/** A cost older than the policy's limit is unknown (rule SY5); manual costs never go stale. */
export function isCostStale(
  supplierCode: SupplierCode,
  costConfirmedAt: Date | null,
  now: Date,
  policy: Pick<SupplierPolicy, 'costStaleMinutes'>,
): boolean {
  if (supplierCode === 'manual') return false;
  if (costConfirmedAt === null) return true;
  return now.getTime() - costConfirmedAt.getTime() > policy.costStaleMinutes * 60_000;
}

/** Rule RT4: why the route is unusable now, or null when it may serve its product. */
export function routeUnusableReason(
  route: RouteFacts,
  now: Date,
  policy: Pick<SupplierPolicy, 'costStaleMinutes'>,
): RouteUnusableReason | null {
  if (route.archived) return 'archived';
  if (!route.enabled) return 'disabled';
  if (!route.supplierAvailable) return 'supplier_unavailable';
  if (!route.supplierConfigured) return 'supplier_not_configured';
  if (route.supplierPaused) return 'supplier_paused';
  if (route.health === 'down') return 'supplier_down';
  if (route.offerMissing) return 'offer_missing';
  if (route.offerUnsupported) return 'offer_unsupported';
  if (!route.inStock) return 'out_of_stock';
  if (route.costUsdUnits === null) return 'cost_unknown';
  if (isCostStale(route.supplierCode, route.costConfirmedAt, now, policy)) return 'cost_stale';
  const keys = new Set(route.liveFieldKeys);
  const mapped = Object.values(route.fieldMap).every((key) => keys.has(key));
  if (
    !mapped ||
    unmappedFields(route.requiredFields, route.fieldMap).length > 0 ||
    unmappedOptions(route.fieldSpecs, route.fieldMap, route.optionMap, route.liveSelectOptions)
      .length > 0
  ) {
    return 'fields_incomplete';
  }
  if (route.balanceUsdUnits !== null && route.balanceUsdUnits < route.costUsdUnits) {
    return 'balance_low';
  }
  return null;
}

/** A route's tier (rule RT5): the manual supplier is a last resort, whatever its cost. */
export function routeTier(supplierCode: SupplierCode, health: SupplierHealthState): RouteTier {
  if (supplierCode === 'manual') return 'manual';
  return health === 'healthy' ? 'healthy' : 'degraded';
}

/** What ordering reads about a route. */
export interface OrderedRoute {
  supplierCode: SupplierCode;
  health: SupplierHealthState;
  costUsdUnits: number | null;
  priority: number;
}

/**
 * Routes in the order the price basis and the router use (rules RT5, RT6): by tier, then cost
 * (unknown last), then priority, then supplier code.
 */
export function orderRoutes<Route extends OrderedRoute>(routes: readonly Route[]): Route[] {
  const tier = (route: Route) => ROUTE_TIERS.indexOf(routeTier(route.supplierCode, route.health));
  const cost = (route: Route) => route.costUsdUnits ?? Number.MAX_SAFE_INTEGER;
  return [...routes].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      cost(a) - cost(b) ||
      a.priority - b.priority ||
      a.supplierCode.localeCompare(b.supplierCode),
  );
}

/** Rule P1: the basis route among the usable routes, or null when there is none. */
export function priceBasis<Route extends OrderedRoute>(
  usableRoutes: readonly Route[],
): Route | null {
  return orderRoutes(usableRoutes)[0] ?? null;
}

// Supplier catalog (S16 SC1–SC14, SF1–SF6) -----------------------------------------------------

/** The supplier's category id: its own text, as it gives it (WDG: digits). */
export const supplierCategoryIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/)
  .meta({ id: 'SupplierCategoryId' });

/** Rule SC5: a category's state in the browser. */
export const SUPPLIER_CATEGORY_STATES = ['not_imported', 'linked', 'new_packs', 'ignored'] as const;

export const supplierCategoryStateSchema = z
  .enum(SUPPLIER_CATEGORY_STATES)
  .meta({ id: 'SupplierCategoryState' });

export type SupplierCategoryState = z.infer<typeof supplierCategoryStateSchema>;

/**
 * Rule SC3, S16 MF1–MF2: why an offer cannot be imported or routed (fields its adapter cannot
 * send: for WDGZone, several fields without an account field, or a select it cannot list).
 */
export const OFFER_UNSUPPORTED_REASONS = ['fields_unsupported'] as const;

export const offerUnsupportedReasonSchema = z
  .enum(OFFER_UNSUPPORTED_REASONS)
  .meta({ id: 'OfferUnsupportedReason' });

export type OfferUnsupportedReason = z.infer<typeof offerUnsupportedReasonSchema>;

/** At most 10 fields per offer, 50 options per field (S16 Data). */
export const MAX_FIELD_SPECS = 10;
export const MAX_FIELD_SPEC_OPTIONS = 50;

/** One account field as the supplier describes it; text is the supplier's, shown as text. */
export const fieldSpecSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
    label: z.string().max(64),
    type: z.enum(['text', 'select']),
    options: z
      .array(z.object({ label: z.string().max(64), value: z.string().min(1).max(64) }))
      .max(MAX_FIELD_SPEC_OPTIONS)
      .optional(),
  })
  .meta({ id: 'FieldSpec' });

export type FieldSpec = z.infer<typeof fieldSpecSchema>;

/** S16 SF5: the supplier's own status and catalog time, as it reports them. */
export const platformStatusSchema = z
  .object({
    status: z.string().max(64),
    catalogUpdatedAt: z.iso.datetime().nullable(),
    checkedAt: z.iso.datetime(),
  })
  .meta({ id: 'PlatformStatus' });

export type PlatformStatus = z.infer<typeof platformStatusSchema>;

/** What the panel may read from a supplier's adapter (S16: `categories`, `statement`, SF5). */
export const supplierPanelCapabilitiesSchema = z
  .object({ categories: z.boolean(), statement: z.boolean(), platformStatus: z.boolean() })
  .meta({ id: 'SupplierPanelCapabilities' });

export type SupplierPanelCapabilities = z.infer<typeof supplierPanelCapabilitiesSchema>;

/** The adapters that declare the S16 capabilities (`wdgzone`, `fake`). */
export function supplierPanelCapabilities(code: SupplierCode): SupplierPanelCapabilities {
  const has = code === 'wdgzone' || code === 'fake';
  return { categories: has, statement: has, platformStatus: has };
}

/** What rule SC5 reads of a category node. */
export interface CategoryNodeFacts {
  categoryId: string;
  parentCategoryId: string | null;
  /** Our game linked to this node itself. */
  gameId: string | null;
  ignored: boolean;
}

/** What rule SC5 reads of an offer under a leaf. */
export interface CategoryOfferFacts {
  categoryId: string | null;
  mapped: boolean;
  ignored: boolean;
  supported: boolean;
  inStock: boolean;
  missing: boolean;
}

/** A node's facts for the browser (rules SC4, SC5): its state, effective game and counts. */
export interface CategoryStanding {
  state: SupplierCategoryState;
  /** Its own link or its nearest linked ancestor's. */
  effectiveGameId: string | null;
  /** Counts of the offers in its subtree. */
  mapped: number;
  unmapped: number;
  ignored: number;
  unsupported: number;
  newPacks: number;
}

/**
 * Rule SC5 for every node at once (`categoryState` of the spec): the effective game is a node's
 * own link or its nearest linked ancestor's; `ignored` when it or an ancestor is ignored; else
 * `not_imported` without an effective game; `new_packs` when an offer of its subtree whose leaf
 * has an effective game is unmapped, not ignored, supported, in stock and not missing; else
 * `linked`. A parent the tree does not hold ends the walk up; a cycle stops at the first repeat.
 */
export function categoryStandings(
  nodes: readonly CategoryNodeFacts[],
  offers: readonly CategoryOfferFacts[],
): Map<string, CategoryStanding> {
  const byId = new Map(nodes.map((node) => [node.categoryId, node]));
  const lines = new Map<string, CategoryNodeFacts[]>();
  const standings = new Map<string, CategoryStanding>();
  for (const node of nodes) {
    // The node and its ancestors, nearest first.
    const chain: CategoryNodeFacts[] = [];
    const seen = new Set<string>();
    let link: CategoryNodeFacts | undefined = node;
    while (link && !seen.has(link.categoryId)) {
      seen.add(link.categoryId);
      chain.push(link);
      link = link.parentCategoryId === null ? undefined : byId.get(link.parentCategoryId);
    }
    lines.set(node.categoryId, chain);
    standings.set(node.categoryId, {
      state: 'not_imported',
      effectiveGameId: chain.find((item) => item.gameId !== null)?.gameId ?? null,
      mapped: 0,
      unmapped: 0,
      ignored: 0,
      unsupported: 0,
      newPacks: 0,
    });
  }
  for (const offer of offers) {
    const chain = offer.categoryId === null ? undefined : lines.get(offer.categoryId);
    if (!chain) continue;
    const leaf = standings.get(offer.categoryId as string) as CategoryStanding;
    const isNew =
      !offer.mapped &&
      !offer.ignored &&
      offer.supported &&
      offer.inStock &&
      !offer.missing &&
      leaf.effectiveGameId !== null;
    for (const link of chain) {
      const standing = standings.get(link.categoryId) as CategoryStanding;
      if (offer.mapped) standing.mapped += 1;
      else standing.unmapped += 1;
      if (offer.ignored) standing.ignored += 1;
      if (!offer.supported) standing.unsupported += 1;
      if (isNew) standing.newPacks += 1;
    }
  }
  for (const [id, standing] of standings) {
    const chain = lines.get(id) as CategoryNodeFacts[];
    standing.state = chain.some((link) => link.ignored)
      ? 'ignored'
      : standing.effectiveGameId === null
        ? 'not_imported'
        : standing.newPacks > 0
          ? 'new_packs'
          : 'linked';
  }
  return standings;
}

/** An input field the import proposes for a supplier field (rules SC12, MF3). */
export interface SuggestedInputField {
  supplierKey: string;
  key: string;
  labelAr: string;
  type: 'digits' | 'text' | 'select';
  /** Null for a `select`. */
  minLength: number | null;
  maxLength: number | null;
  /** A `select`'s options (S06: 2–50, unique values); null otherwise. */
  options: SelectOption[] | null;
  required: true;
}

const FIELD_LABELS_AR: Readonly<Record<string, string>> = {
  player_id: 'معرّف اللاعب',
  user_id: 'معرّف اللاعب',
  uid: 'معرّف اللاعب',
  server_id: 'السيرفر',
  server: 'السيرفر',
  zone_id: 'رقم المنطقة',
  role_id: 'معرّف الشخصية',
  riot_id: 'Riot ID',
  region: 'المنطقة',
};

const DIGIT_FIELDS = new Set(['player_id', 'user_id', 'uid', 'zone_id', 'server_id', 'role_id']);

/** S06's bounds of a select (rule CT7). */
const SELECT_OPTIONS_MIN = 2;
const SELECT_OPTIONS_MAX = 50;
/** S06 keys and option values are at most 32 characters, option labels 40. */
const KEY_MAX = 32;
const LABEL_MAX = 40;

/** `base`, else `base_2`, `base_3`… within 32 characters, not in `taken` (which it joins). */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) {
    const suffix = `_${n}`;
    name = `${base.slice(0, KEY_MAX - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

/** Rule SC12's sanitizing: lower case, characters outside `[a-z0-9_]` as `_`, cut to 32. */
const sanitizedName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, KEY_MAX);

/** A supplier text cut to an S06 label, else the fallback. */
const labelOf = (text: string, fallback: string) =>
  text.trim().slice(0, LABEL_MAX).trim() || fallback;

/**
 * Rule SC12, per supplier field (each key once): our key is the supplier key lower-cased with
 * characters outside `[a-z0-9_]` turned to `_`, prefixed `f_` when it does not start with a
 * letter, cut to 32, given `_f` when shorter than 2 (S06 keys have 2 or more) and made unique
 * with `_2`, `_3`…; the Arabic label from the dictionary, else the supplier's label (cut to 40),
 * else the key; type `digits` (1–32) for id fields, else `text` (1–64); always required.
 *
 * S16 MF3: a supplier `select` with 2 to 50 options becomes our `select` with its options (the
 * first pack's: labels kept and cut to 40, values sanitized as keys and made unique), and the
 * option map sends each of our values as the supplier's (MF2). Other selects stay text: their
 * offers are unsupported anyway.
 */
export function suggestInputFields(
  specs: readonly (Pick<FieldSpec, 'key' | 'label'> &
    Partial<Pick<FieldSpec, 'type' | 'options'>>)[],
): {
  fields: SuggestedInputField[];
  fieldMap: Record<string, string>;
  optionMap: OptionMap;
} {
  const fields: SuggestedInputField[] = [];
  const fieldMap: Record<string, string> = {};
  const optionMap: OptionMap = {};
  const taken = new Set<string>();
  for (const spec of specs) {
    if (Object.hasOwn(fieldMap, spec.key)) continue;
    const canonical = spec.key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    let base = /^[a-z]/.test(canonical) ? canonical : `f_${canonical}`;
    base = base.slice(0, KEY_MAX);
    if (base.length < 2) base = `${base}_f`;
    const key = uniqueName(base, taken);
    const labelAr = FIELD_LABELS_AR[canonical] ?? labelOf(spec.label, key);
    fieldMap[spec.key] = key;
    const choices = spec.type === 'select' ? (spec.options ?? []) : [];
    if (choices.length >= SELECT_OPTIONS_MIN && choices.length <= SELECT_OPTIONS_MAX) {
      const values = new Set<string>();
      const options = choices.map((choice) => {
        const value = uniqueName(sanitizedName(choice.value), values);
        return { value, labelAr: labelOf(choice.label, value) };
      });
      optionMap[spec.key] = Object.fromEntries(
        options.map((option, index) => [option.value, choices[index]?.value as string]),
      );
      fields.push({
        supplierKey: spec.key,
        key,
        labelAr,
        type: 'select',
        minLength: null,
        maxLength: null,
        options,
        required: true,
      });
      continue;
    }
    const digits = DIGIT_FIELDS.has(canonical);
    fields.push({
      supplierKey: spec.key,
      key,
      labelAr,
      type: digits ? 'digits' : 'text',
      minLength: 1,
      maxLength: digits ? 32 : 64,
      options: null,
      required: true,
    });
  }
  return { fields, fieldMap, optionMap };
}

/**
 * S16 MF3 (link, SC8): each option of our select proposed onto one of the supplier's, by equal
 * value, else equal label, else equal sanitized value (case and spaces aside); an option with no
 * equal is left out, so the route stays incomplete until the admin maps it.
 */
export function proposeOptionMap(
  ours: readonly SelectOption[],
  theirs: readonly NonNullable<FieldSpec['options']>[number][],
): Record<string, string> {
  const plain = (text: string) => text.trim().toLowerCase();
  const proposal: Record<string, string> = {};
  for (const option of ours) {
    const match =
      theirs.find((choice) => choice.value === option.value) ??
      theirs.find((choice) => plain(choice.label) === plain(option.labelAr)) ??
      theirs.find((choice) => sanitizedName(choice.value.trim()) === option.value);
    if (match) proposal[option.value] = match.value;
  }
  return proposal;
}

/** A product name is at most 60 characters (S06). */
const PRODUCT_NAME_MAX = 60;

/**
 * Rule SC13: the supplier's pack name, with ` · <leaf name>` when the chosen packs span more than
 * one leaf and the leaf name is not already in it, cut to 60.
 */
export function suggestProductName(
  offerName: string,
  leafName: string,
  spansLeaves: boolean,
): string {
  const name = offerName.trim();
  const leaf = leafName.trim();
  const named = spansLeaves && leaf !== '' && !name.includes(leaf) ? `${name} · ${leaf}` : name;
  return named.slice(0, PRODUCT_NAME_MAX).trim();
}

/** A game amount is 1 to 1,000,000,000 (S06). */
const GAME_AMOUNT_MAX = 1_000_000_000;

/**
 * Rule SC13: the first whole number in the pack name (thousands separated by commas read as one
 * number), when it is a valid game amount; else null.
 */
export function parseGameAmount(name: string): number | null {
  const match = /\d{1,3}(?:,\d{3})+(?!\d)|\d+/.exec(name);
  if (!match) return null;
  const amount = Number(match[0].replaceAll(',', ''));
  return amount >= 1 && amount <= GAME_AMOUNT_MAX ? amount : null;
}

/**
 * Rule SF1: `⌊(original − cost) × 100 / original⌋` %, only when the original is known and above
 * the cost (and the discount is at least 1%); else null.
 */
export function discountPercent(
  costUsdUnits: number | null,
  originalUsdUnits: number | null,
): number | null {
  if (costUsdUnits === null || originalUsdUnits === null || originalUsdUnits <= costUsdUnits) {
    return null;
  }
  const percent = Math.floor(((originalUsdUnits - costUsdUnits) * 100) / originalUsdUnits);
  return percent >= 1 ? percent : null;
}

/**
 * Rule SF2: `out` when not in stock or at 0, `unlimited` when no figure is reported, `low` below
 * the threshold, else `ok`.
 */
export function stockLevel(
  stock: number | null,
  inStock: boolean,
  thresholdUnits: number,
): StockLevel {
  if (!inStock || stock === 0) return 'out';
  if (stock === null) return 'unlimited';
  return stock < thresholdUnits ? 'low' : 'ok';
}

const STOCK_RANK: Readonly<Record<StockLevel, number>> = { ok: 0, unlimited: 0, low: 1, out: 2 };

/**
 * Rule SF2's alert: a level that rose since the stored alert (`ok` → `low`, `ok` or `low` → `out`)
 * alerts and is stored; a level back at or above the threshold clears the stored one, so the next
 * drop alerts again; anything else keeps it (`out` → `low` stays `out`).
 */
export function stockAlertChange(
  stored: StockLevel | null,
  current: StockLevel,
): { alert: boolean; next: StockLevel | null } {
  const now = STOCK_RANK[current];
  const before = stored === null ? 0 : STOCK_RANK[stored];
  if (now > before) return { alert: true, next: current };
  if (now === 0) return { alert: false, next: null };
  return { alert: false, next: stored };
}

// Schemas ---------------------------------------------------------------------------------------

/** A supplier cost: above zero, at most $10,000. */
export const supplierCostSchema = z.int().min(1).max(SUPPLIER_COST_MAX_USD_UNITS);

/** A cost the admin types for a manual offer (rule RT7): whole cents. */
export const manualCostSchema = usdCentsSchema.min(USD_CENT).max(SUPPLIER_COST_MAX_USD_UNITS);

const supplierFieldName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const inputFieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);

/** Supplier field name → input field key of the product's game (rule RT3). */
export const fieldMapSchema = z
  .record(supplierFieldName, inputFieldKey)
  .refine((map) => Object.keys(map).length <= MAX_FIELD_MAP_ENTRIES, {
    message: `Expected at most ${MAX_FIELD_MAP_ENTRIES} entries`,
  })
  .meta({ id: 'FieldMap' });

export type FieldMap = z.infer<typeof fieldMapSchema>;

/**
 * S16 MF2: supplier field name → our option value → the supplier's option value, at most 10
 * fields of at most 50 options; values bounded as field specs. The adapter is only sent values
 * from the supplier's own list.
 */
export const optionMapSchema = z
  .record(
    supplierFieldName,
    z
      .record(selectOptionSchema.shape.value, z.string().min(1).max(64))
      .refine((options) => Object.keys(options).length <= MAX_FIELD_SPEC_OPTIONS, {
        message: `Expected at most ${MAX_FIELD_SPEC_OPTIONS} options`,
      }),
  )
  .refine((map) => Object.keys(map).length <= MAX_FIELD_SPECS, {
    message: `Expected at most ${MAX_FIELD_SPECS} fields`,
  })
  .meta({ id: 'OptionMap' });

export type OptionMap = z.infer<typeof optionMapSchema>;

const priority = z.int().min(1).max(ROUTE_PRIORITY_MAX);

export const syncRunSchema = z
  .object({
    id: z.uuid(),
    supplierCode: supplierCodeSchema,
    trigger: syncRunTriggerSchema,
    status: syncRunStatusSchema,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    offersSeen: z.int().nonnegative(),
    offersNew: z.int().nonnegative(),
    costsChanged: z.int().nonnegative(),
    offersMissing: z.int().nonnegative(),
    reviewsOpened: z.int().nonnegative(),
    productsRepriced: z.int().nonnegative(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .meta({ id: 'SyncRun' });

export type SyncRun = z.infer<typeof syncRunSchema>;

export const syncRunPageSchema = pagedListSchema(syncRunSchema, 'SyncRunPage');

export type SyncRunPage = z.infer<typeof syncRunPageSchema>;

export const supplierBalanceSchema = z
  .object({
    id: z.uuid(),
    currency: currencySchema,
    amountUnits: z.int(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SupplierBalance' });

export type SupplierBalance = z.infer<typeof supplierBalanceSchema>;

export const supplierHealthChangeSchema = z
  .object({
    id: z.uuid(),
    state: supplierHealthStateSchema,
    reason: z.string(),
    calls: z.int().nonnegative().nullable(),
    successBp: z.int().min(0).max(10_000).nullable(),
    p90Ms: z.int().nonnegative().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SupplierHealthChange' });

export type SupplierHealthChange = z.infer<typeof supplierHealthChangeSchema>;

/** `GET /api/admin/suppliers`: one card per supplier. */
export const supplierSummarySchema = z
  .object({
    code: supplierCodeSchema,
    nameAr: z.string(),
    available: z.boolean(),
    configured: z.boolean(),
    paused: z.boolean(),
    health: supplierHealthStateSchema,
    healthSince: z.iso.datetime().nullable(),
    balance: supplierBalanceSchema.nullable(),
    /** The newest balance is in USD and below the threshold (rule H5). */
    balanceLow: z.boolean(),
    lowBalanceUsdUnits: z.int().nonnegative(),
    lastRun: syncRunSchema.nullable(),
    offerCount: z.int().nonnegative(),
    mappedCount: z.int().nonnegative(),
    /** The adapter can check a player id (S09 rule PV1). */
    canValidatePlayer: z.boolean(),
    /** S09 rule AD2: the daily validation quota and today's calls (since 00:00 Damascus). */
    validationQuota: z.int().nonnegative(),
    validationsToday: z.int().nonnegative(),
    /** S16: what the supplier's adapter can read for the panel. */
    capabilities: supplierPanelCapabilitiesSchema,
    /** S16 SC11: offers counted new in imported categories (rule SC5). */
    newOfferCount: z.int().nonnegative(),
    /** S16 SF2: mapped offers of active products that are low or out of stock. */
    lowStockCount: z.int().nonnegative(),
    /** S16 SF5: the supplier's own status when the API read it in the last minute. */
    platformStatus: platformStatusSchema.nullable(),
  })
  .meta({ id: 'SupplierSummary' });

export type SupplierSummary = z.infer<typeof supplierSummarySchema>;

/** `GET /api/admin/suppliers/:code`: never the credential values, only their hints (rule SP2). */
export const supplierDetailSchema = supplierSummarySchema
  .extend({
    credentialFields: z.array(z.string()),
    credentials: z
      .object({
        /** Per field, its last 4 characters. */
        hints: z.record(z.string(), z.string()),
        setAt: z.iso.datetime(),
      })
      .nullable(),
    healthHistory: z.array(supplierHealthChangeSchema),
    balanceHistory: z.array(supplierBalanceSchema),
  })
  .meta({ id: 'SupplierDetail' });

export type SupplierDetail = z.infer<typeof supplierDetailSchema>;

/** `PUT /api/admin/suppliers/:code/credentials`: every field of that supplier (rule SP2). */
export const setSupplierCredentialsSchema = z
  .object({ values: z.record(supplierFieldName, z.string().trim().min(1).max(500)) })
  .meta({ id: 'SetSupplierCredentials' });

export type SetSupplierCredentials = z.infer<typeof setSupplierCredentialsSchema>;

/** `PATCH /api/admin/suppliers/:code` (A07). */
export const updateSupplierSchema = z
  .object({ lowBalanceUsdUnits: usdCentsSchema.max(LOW_BALANCE_MAX_USD_UNITS) })
  .meta({ id: 'UpdateSupplier' });

export type UpdateSupplier = z.infer<typeof updateSupplierSchema>;

/** A supplier's daily player-validation quota (S09 rule PV5): 0 turns validation off for it. */
export const VALIDATION_QUOTA_MAX = 1_000_000;
export const VALIDATION_QUOTA_DEFAULT = 1_000;

/** `PUT /api/admin/suppliers/:code/validation-quota` (rule AD2). */
export const validationQuotaSchema = z
  .object({ quota: z.int().min(0).max(VALIDATION_QUOTA_MAX) })
  .meta({ id: 'ValidationQuota' });

export type ValidationQuota = z.infer<typeof validationQuotaSchema>;

const booleanFilter = z.enum(['true', 'false']).optional();

export const offerListQuerySchema = pageQuerySchema
  .extend({
    /** Part of the offer's name or of the supplier's offer id. */
    q: z.string().trim().min(1).max(100).optional(),
    group: z.string().trim().min(1).max(200).optional(),
    mapped: booleanFilter,
    missing: booleanFilter,
    inStock: booleanFilter,
    /** S16 SF1: offers whose leaf category is this supplier category or one below it. */
    categoryId: supplierCategoryIdSchema.optional(),
    supported: booleanFilter,
    ignored: booleanFilter,
    /** Mapped offers whose stock level is `low` or `out` (rule SF2). */
    lowStock: booleanFilter,
  })
  .meta({ id: 'OfferListQuery' });

export type OfferListQuery = z.infer<typeof offerListQuerySchema>;

export const supplierOfferSchema = z
  .object({
    id: z.uuid(),
    supplierCode: supplierCodeSchema,
    /** The supplier's own id. */
    offerId: z.string(),
    name: z.string(),
    groupName: z.string().nullable(),
    kind: productKindSchema.nullable(),
    requiredFields: z.array(z.string()).nullable(),
    costUsdUnits: z.int().nullable(),
    /** The supplier's raw value when it gave no usable USD cost. */
    costRaw: z.string().nullable(),
    inStock: z.boolean(),
    costConfirmedAt: z.iso.datetime().nullable(),
    costStale: z.boolean(),
    lastSeenAt: z.iso.datetime(),
    missingSince: z.iso.datetime().nullable(),
    /** S16 SF1: the supplier's leaf category and its names from the root; null when unknown. */
    categoryId: z.string().nullable(),
    categoryPath: z.array(z.string()),
    /** The reported stock; null when unlimited or not reported (rule SF2). */
    stock: z.int().nonnegative().nullable(),
    stockLevel: stockLevelSchema,
    /** The supplier's price before its discount, and the discount (rule SF1). */
    originalCostUsdUnits: z.int().nullable(),
    discountPercent: z.int().min(1).max(100).nullable(),
    fieldSpecs: z.array(fieldSpecSchema).nullable(),
    /** Not usable until PR4 (rule SC3). */
    unsupportedReason: offerUnsupportedReasonSchema.nullable(),
    ignoredAt: z.iso.datetime().nullable(),
    /** The product its unarchived route serves (rule RT1). */
    mapped: z
      .object({
        routeId: z.uuid(),
        productId: z.uuid(),
        productNameAr: z.string(),
        gameId: z.uuid(),
        gameNameAr: z.string(),
      })
      .nullable(),
  })
  .meta({ id: 'SupplierOffer' });

export type SupplierOffer = z.infer<typeof supplierOfferSchema>;

export const supplierOfferPageSchema = pagedListSchema(supplierOfferSchema, 'SupplierOfferPage');

export type SupplierOfferPage = z.infer<typeof supplierOfferPageSchema>;

export const offerCostChangeSchema = z
  .object({
    id: z.uuid(),
    fromUsdUnits: z.int().nullable(),
    toUsdUnits: z.int().nullable(),
    syncRunId: z.uuid().nullable(),
    /** Set by the admin (a manual offer, rule RT7). */
    byAdmin: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'OfferCostChange' });

export type OfferCostChange = z.infer<typeof offerCostChangeSchema>;

export const offerCostChangePageSchema = pagedListSchema(
  offerCostChangeSchema,
  'OfferCostChangePage',
);

export type OfferCostChangePage = z.infer<typeof offerCostChangePageSchema>;

/** `POST /api/admin/suppliers/:code/import` (rule RT8): all or nothing. */
export const importOffersSchema = z
  .object({
    gameId: z.uuid(),
    /** The kind of the offers whose kind the supplier does not give. */
    kind: productKindSchema.optional(),
    fieldMap: fieldMapSchema.default({}),
    optionMap: optionMapSchema.default({}),
    rows: z
      .array(
        z.object({
          /** The offer's id in `supplier_offers`. */
          offerId: z.uuid(),
          nameAr: z
            .string()
            .trim()
            .min(1)
            .max(60)
            .regex(/^[^\p{Cc}]+$/u),
        }),
      )
      .min(1)
      .max(MAX_IMPORT_ROWS)
      .refine(
        (rows) => new Set(rows.map((row) => row.offerId)).size === rows.length,
        'Expected each offer once',
      ),
  })
  .meta({ id: 'ImportOffers' });

export type ImportOffers = z.input<typeof importOffersSchema>;

/** A refused import row, in the refusal's `details.rows` (edge case 10). */
export interface ImportRowError {
  index: number;
  code: string;
}

export const importResultSchema = z
  .object({
    products: z.array(
      z.object({
        id: z.uuid(),
        nameAr: z.string(),
        routeId: z.uuid(),
        priceUsdUnits: z.int().nullable(),
      }),
    ),
  })
  .meta({ id: 'ImportResult' });

export type ImportResult = z.infer<typeof importResultSchema>;

export const createRouteSchema = z
  .object({
    offerId: z.uuid(),
    priority: priority.default(1),
    fieldMap: fieldMapSchema.default({}),
    optionMap: optionMapSchema.default({}),
  })
  .meta({ id: 'CreateRoute' });

export type CreateRoute = z.input<typeof createRouteSchema>;

export const createManualRouteSchema = z
  .object({ costUsdUnits: manualCostSchema })
  .meta({ id: 'CreateManualRoute' });

export type CreateManualRoute = z.infer<typeof createManualRouteSchema>;

export const updateRouteSchema = z
  .object({
    priority,
    enabled: z.boolean(),
    fieldMap: fieldMapSchema,
    optionMap: optionMapSchema,
  })
  .partial()
  .meta({ id: 'UpdateRoute' });

export type UpdateRoute = z.infer<typeof updateRouteSchema>;

export const setManualCostSchema = createManualRouteSchema.meta({ id: 'SetManualCost' });

export const routeSchema = z
  .object({
    id: z.uuid(),
    supplierCode: supplierCodeSchema,
    supplierNameAr: z.string(),
    offer: supplierOfferSchema.pick({
      id: true,
      offerId: true,
      name: true,
      kind: true,
      requiredFields: true,
      costUsdUnits: true,
      costConfirmedAt: true,
      inStock: true,
      missingSince: true,
      stock: true,
      stockLevel: true,
      fieldSpecs: true,
    }),
    priority: z.int(),
    enabled: z.boolean(),
    fieldMap: z.record(z.string(), z.string()),
    /** S16 MF2. */
    optionMap: z.record(z.string(), z.record(z.string(), z.string())),
    archivedAt: z.iso.datetime().nullable(),
    /** Null for an unusable route. */
    tier: routeTierSchema.nullable(),
    unusableReason: routeUnusableReasonSchema.nullable(),
    /** The route the price follows (rule P1). */
    basis: z.boolean(),
    /** The supplier does not publish the offer's fields: mapped from its documentation (RT3). */
    requirementsUnknown: z.boolean(),
  })
  .meta({ id: 'Route' });

export type Route = z.infer<typeof routeSchema>;

/** A product's routes and price (the routes drawer). */
export const productRoutingSchema = z
  .object({
    productId: z.uuid(),
    /** Usable routes in tier order (RT5, RT6), then unusable, then archived ones. */
    routes: z.array(routeSchema),
    basisRouteId: z.uuid().nullable(),
    currentPrice: z
      .object({
        priceUsdUnits: z.int(),
        costUsdUnits: z.int(),
        routeId: z.uuid(),
        createdAt: z.iso.datetime(),
      })
      .nullable(),
    /** The price the basis gives now (rule P1); null with no usable route. */
    targetPriceUsdUnits: z.int().nullable(),
    openReview: z
      .object({
        id: z.uuid(),
        costBeforeUsdUnits: z.int(),
        costAfterUsdUnits: z.int(),
        changeBp: z.int(),
        proposedPriceUsdUnits: z.int(),
      })
      .nullable(),
    availability: productAvailabilitySchema,
  })
  .meta({ id: 'ProductRouting' });

export type ProductRouting = z.infer<typeof productRoutingSchema>;

// Supplier catalog schemas (S16) ---------------------------------------------------------------

/** At most 200 categories per page (rule SC4). */
export const MAX_CATEGORY_PAGE_SIZE = 200;

/**
 * `GET /api/admin/suppliers/:code/categories` (rule SC4): a level of the tree (the roots without
 * `parentId`), or, with `q` or `state`, matching nodes at any depth shown with their path.
 */
export const supplierCategoryListQuerySchema = pageQuerySchema
  .extend({
    pageSize: z.coerce.number().int().min(1).max(MAX_CATEGORY_PAGE_SIZE).default(100),
    parentId: supplierCategoryIdSchema.optional(),
    state: supplierCategoryStateSchema.optional(),
    kind: productKindSchema.optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .meta({ id: 'SupplierCategoryListQuery' });

export type SupplierCategoryListQuery = z.infer<typeof supplierCategoryListQuerySchema>;

/** One node of a supplier's tree with our link, ignore state and counts (rules SC4, SC5). */
export const supplierCategoryNodeSchema = z
  .object({
    supplierCode: supplierCodeSchema,
    categoryId: z.string(),
    parentCategoryId: z.string().nullable(),
    name: z.string(),
    /** The names of its ancestors, root first. */
    path: z.array(z.string()),
    kind: productKindSchema.nullable(),
    /** The supplier's own figures. */
    productCount: z.int().nonnegative().nullable(),
    inStockCount: z.int().nonnegative().nullable(),
    hasImage: z.boolean(),
    childCount: z.int().nonnegative(),
    /** Our counts of its subtree's offers. */
    counts: z.object({
      mapped: z.int().nonnegative(),
      unmapped: z.int().nonnegative(),
      ignored: z.int().nonnegative(),
      unsupported: z.int().nonnegative(),
      newPacks: z.int().nonnegative(),
    }),
    state: supplierCategoryStateSchema,
    /** Its effective game: its own link or its nearest linked ancestor's. */
    game: z.object({ id: z.uuid(), nameAr: z.string() }).nullable(),
    /** The game is linked to this node itself (it can be unlinked here). */
    linkedHere: z.boolean(),
    ignoredAt: z.iso.datetime().nullable(),
    missingSince: z.iso.datetime().nullable(),
    lastSeenAt: z.iso.datetime(),
  })
  .meta({ id: 'SupplierCategoryNode' });

export type SupplierCategoryNode = z.infer<typeof supplierCategoryNodeSchema>;

export const supplierCategoryPageSchema = pagedListSchema(
  supplierCategoryNodeSchema,
  'SupplierCategoryPage',
);

export type SupplierCategoryPage = z.infer<typeof supplierCategoryPageSchema>;

/** `GET …/import-draft`: with `gameId`, a draft to link the node to that game (rule SC8). */
export const importDraftQuerySchema = z
  .object({ gameId: z.uuid().optional() })
  .meta({ id: 'ImportDraftQuery' });

export type ImportDraftQuery = z.infer<typeof importDraftQuerySchema>;

/** Why a pack row cannot be imported or linked (rules SC3, SC7, RT1, RT2). */
export const IMPORT_PACK_REFUSALS = [
  'OFFER_UNSUPPORTED',
  /** S16 MF3: its select lacks a supplier value for one of our options. */
  'FIELD_OPTIONS_DIFFER',
  'OFFER_IGNORED',
  'OFFER_ALREADY_MAPPED',
  'OFFER_MISSING',
  'ROUTE_KIND_MISMATCH',
] as const;

/** A pack of the node's subtree as the import and link dialogs show it (rules SC7, SC8, SF1). */
export const importDraftPackSchema = z
  .object({
    /** The offer's id in `supplier_offers`. */
    offerId: z.uuid(),
    supplierOfferId: z.string(),
    name: z.string(),
    leafCategoryId: z.string(),
    leafName: z.string(),
    kind: productKindSchema.nullable(),
    costUsdUnits: z.int().nullable(),
    originalCostUsdUnits: z.int().nullable(),
    discountPercent: z.int().nullable(),
    stock: z.int().nonnegative().nullable(),
    stockLevel: stockLevelSchema,
    requiredFields: z.array(z.string()).nullable(),
    /** S16 MF3: its fields with their select options, to check option changes in place. */
    fieldSpecs: z.array(fieldSpecSchema).nullable(),
    /** Why the row cannot be chosen, or null. */
    refusal: z.enum(IMPORT_PACK_REFUSALS).nullable(),
    suggestedNameAr: z.string(),
    suggestedGameAmount: z.int().nullable(),
    /** The price the store would charge at the margin rule that would govern it; null: no cost. */
    pricePreviewUsdUnits: z.int().nullable(),
    /** A link draft: the existing product with the same game amount or name (rule SC8). */
    match: z.object({ productId: z.uuid(), nameAr: z.string() }).nullable(),
  })
  .meta({ id: 'ImportDraftPack' });

export type ImportDraftPack = z.infer<typeof importDraftPackSchema>;

/** A suggested input field beside the supplier field it comes from (rule SC12). */
export const suggestedInputFieldSchema = z
  .object({
    supplierKey: z.string(),
    supplierLabel: z.string(),
    supplierType: z.enum(['text', 'select']),
    /** S16 MF3: the supplier's options of a select (the first pack's). */
    supplierOptions: fieldSpecSchema.shape.options.unwrap().nullable(),
    key: z.string(),
    labelAr: z.string(),
    type: z.enum(['digits', 'text', 'select']),
    minLength: z.int().nullable(),
    maxLength: z.int().nullable(),
    options: z.array(selectOptionSchema).nullable(),
    required: z.boolean(),
  })
  .meta({ id: 'SuggestedInputField' });

/** `GET …/import-draft` (rules SC7, SC8, SC12–SC14). */
export const importDraftSchema = z
  .object({
    category: supplierCategoryNodeSchema,
    /** The kind most packs of the subtree have; null when the supplier gives none. */
    kind: productKindSchema.nullable(),
    /** SC14: the new game's suggested names, store category and slug. */
    game: z.object({
      nameAr: z.string(),
      nameEn: z.string(),
      slug: z.string(),
      categoryId: z.uuid().nullable(),
    }),
    /** A link draft: the game and its unarchived fields. */
    linkGame: z
      .object({
        id: z.uuid(),
        nameAr: z.string(),
        fields: z.array(
          z.object({
            key: z.string(),
            labelAr: z.string(),
            type: inputFieldTypeSchema,
            options: z.array(selectOptionSchema).nullable(),
          }),
        ),
      })
      .nullable(),
    fields: z.array(suggestedInputFieldSchema),
    fieldMap: z.record(z.string(), z.string()),
    /** S16 MF2, MF3: the suggested (or, for a link, proposed) option map. */
    optionMap: z.record(z.string(), z.record(z.string(), z.string())),
    packs: z.array(importDraftPackSchema),
  })
  .meta({ id: 'ImportDraft' });

export type ImportDraft = z.infer<typeof importDraftSchema>;

const packName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{Cc}]+$/u);

/** A pack row that creates a new paused product (rules SC7, SC8). */
const newPackRowSchema = z.object({
  offerId: z.uuid(),
  nameAr: packName,
  gameAmount: z.int().min(1).max(1_000_000_000).nullable().optional(),
});

const eachOfferOnce = (rows: { offerId: string }[]) =>
  new Set(rows.map((row) => row.offerId)).size === rows.length;

/** `POST …/import` (rule SC7): a new paused game with its fields, packs, routes and prices. */
export const importCategorySchema = z
  .object({
    game: createGameSchema.pick({
      slug: true,
      categoryId: true,
      nameAr: true,
      nameEn: true,
      accentColor: true,
      regionNotesAr: true,
    }),
    /** IM2: the supplier's image, or a file uploaded through S06's image route. */
    cover: z.union([
      z.object({ supplierImage: z.literal(true) }),
      z.object({ coverFileId: z.uuid() }),
    ]),
    fields: z.array(createInputFieldSchema).max(MAX_INPUT_FIELDS_PER_GAME),
    fieldMap: fieldMapSchema.default({}),
    optionMap: optionMapSchema.default({}),
    rows: z.array(newPackRowSchema).min(1).max(MAX_IMPORT_ROWS).refine(eachOfferOnce, {
      message: 'Expected each offer once',
    }),
  })
  .meta({ id: 'ImportCategory' });

export type ImportCategory = z.input<typeof importCategorySchema>;

/** `POST …/link` (rule SC8): rows that route an existing product or create a new one. */
export const linkCategorySchema = z
  .object({
    gameId: z.uuid(),
    fieldMap: fieldMapSchema.default({}),
    optionMap: optionMapSchema.default({}),
    rows: z
      .array(z.union([z.object({ offerId: z.uuid(), productId: z.uuid() }), newPackRowSchema]))
      .max(MAX_IMPORT_ROWS)
      .refine(eachOfferOnce, { message: 'Expected each offer once' }),
  })
  .meta({ id: 'LinkCategory' });

export type LinkCategory = z.input<typeof linkCategorySchema>;

/** The answer of an import or a link: the game and each row's product, route and price. */
export const categoryImportResultSchema = z
  .object({
    gameId: z.uuid(),
    products: z.array(
      z.object({
        id: z.uuid(),
        nameAr: z.string(),
        routeId: z.uuid(),
        /** The row added a route to an existing product (rule SC8). */
        existing: z.boolean(),
        priceUsdUnits: z.int().nullable(),
      }),
    ),
  })
  .meta({ id: 'CategoryImportResult' });

export type CategoryImportResult = z.infer<typeof categoryImportResultSchema>;

/** `POST /api/admin/catalog/games/:id/cover/from-supplier` (rule IM3). */
export const coverFromSupplierSchema = z
  .object({ supplier: supplierCodeSchema, categoryId: supplierCategoryIdSchema })
  .meta({ id: 'CoverFromSupplier' });

export type CoverFromSupplier = z.infer<typeof coverFromSupplierSchema>;

/** A page of the supplier's statement (rule SF3), read live one page at a time. */
export const statementQuerySchema = z
  .object({ page: z.coerce.number().int().min(1).max(1_000).default(1) })
  .meta({ id: 'StatementQuery' });

export type StatementQuery = z.infer<typeof statementQuerySchema>;
