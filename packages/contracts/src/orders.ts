import { z } from 'zod';
import { phoneSchema } from './auth.js';
import {
  type AvailabilityFacts,
  catalogImageSchema,
  type InputField,
  MAX_INPUT_FIELDS_PER_GAME,
  MAX_QUANTITY_LIMIT,
  type ProductAvailability,
  productAvailability,
  productKindSchema,
  productSchema,
} from './catalog.js';
import { REFERENCE_CODE_ALPHABET } from './deposits.js';
import { cursorPageSchema, cursorQuerySchema, pagedListSchema, pageQuerySchema } from './lists.js';
import { usdCentsSchema } from './money.js';
import {
  orderRoutes,
  ROUTE_UNUSABLE_REASONS,
  type RouteTier,
  type RouteUnusableReason,
  routeTier,
  routeTierSchema,
  type SupplierCode,
  type SupplierHealthState,
  supplierCodeSchema,
} from './suppliers.js';

/*
 * Orders and their fulfilment (S08, F11; ADR 0004, 0005, 0013), owned by the api `orders` module:
 * the state machine, the purchase, routing per attempt, polling times, codes and the customer's
 * and the admin's views. Money is USD units; the write path is `packages/db/src/orders`.
 */

/** Order statuses (ADR 0004). */
export const ORDER_STATUSES = [
  'awaiting_balance',
  'paid',
  'sent_to_supplier',
  'failed',
  'needs_review',
  'delivered',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;

export const orderStatusSchema = z.enum(ORDER_STATUSES).meta({ id: 'OrderStatus' });

export type OrderStatus = z.infer<typeof orderStatusSchema>;

/**
 * The only allowed status changes: ADR 0004's table, plus `paid → refunded` when no profitable
 * route is left (ADR 0013). A status with no next status is terminal. The write path in
 * `packages/db` applies a change with `WHERE status = <from>`.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  awaiting_balance: ['paid', 'cancelled'],
  paid: ['sent_to_supplier', 'refunded'],
  sent_to_supplier: ['delivered', 'failed', 'needs_review'],
  failed: ['sent_to_supplier', 'refunded', 'partially_refunded'],
  needs_review: ['delivered', 'sent_to_supplier', 'refunded', 'partially_refunded'],
  delivered: [],
  partially_refunded: [],
  refunded: [],
  cancelled: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** True for `delivered`, `partially_refunded`, `refunded` and `cancelled`: the order is over. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

/** What the customer sees instead of the internal status (rule O13; S09 adds the reservation). */
export const ORDER_STAGES = [
  'awaiting_balance',
  'processing',
  'delayed',
  'delivered',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;

export const orderStageSchema = z.enum(ORDER_STAGES).meta({ id: 'OrderStage' });

export type OrderStage = z.infer<typeof orderStageSchema>;

const STAGE_OF: Readonly<Record<OrderStatus, OrderStage>> = {
  awaiting_balance: 'awaiting_balance',
  paid: 'processing',
  sent_to_supplier: 'processing',
  failed: 'processing',
  needs_review: 'delayed',
  delivered: 'delivered',
  partially_refunded: 'partially_refunded',
  refunded: 'refunded',
  cancelled: 'cancelled',
};

/** Rule O13: the stage the customer sees for a status. */
export function orderCustomerStage(status: OrderStatus): OrderStage {
  return STAGE_OF[status];
}

/** The steps of the customer's order timeline (S09 rule LT1). */
export const ORDER_TIMELINE_STEPS = [
  'reserved',
  'paid',
  'sent',
  'retrying',
  'delayed',
  'delivered',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;

export const orderTimelineStepSchema = z
  .enum(ORDER_TIMELINE_STEPS)
  .meta({ id: 'OrderTimelineStep' });

export type OrderTimelineStep = z.infer<typeof orderTimelineStepSchema>;

const STEP_OF: Readonly<Record<OrderStatus, OrderTimelineStep | null>> = {
  awaiting_balance: 'reserved',
  paid: 'paid',
  sent_to_supplier: 'sent',
  // Short-lived: the next attempt or the refund follows at once.
  failed: null,
  needs_review: 'delayed',
  delivered: 'delivered',
  partially_refunded: 'partially_refunded',
  refunded: 'refunded',
  cancelled: 'cancelled',
};

/**
 * Rule LT1: the order's status changes, oldest first, as the customer's steps. The first
 * `sent_to_supplier` is `sent` and a later one `retrying`; a step that comes again keeps only its
 * newest time, in its new place; `failed` adds nothing.
 */
export function orderTimeline(
  changes: readonly { status: OrderStatus; at: Date }[],
): { step: OrderTimelineStep; at: Date }[] {
  const timeline: { step: OrderTimelineStep; at: Date }[] = [];
  for (const change of changes) {
    let step = STEP_OF[change.status];
    if (step === null) continue;
    if (step === 'sent' && timeline.some((entry) => entry.step === 'sent')) step = 'retrying';
    const seen = timeline.findIndex((entry) => entry.step === step);
    if (seen !== -1) timeline.splice(seen, 1);
    timeline.push({ step, at: change.at });
  }
  return timeline;
}

// Reservations and player checks (S09) ----------------------------------------------------------

/** A reservation waits this long for a balance (rule RS1, A15), and a customer holds at most 3. */
export const RESERVATION_HOURS = 24;
export const RESERVATIONS_MAX = 3;

/** Why an order was cancelled (rules RS7–RS9); set only on `cancelled` orders. */
export const CANCEL_REASONS = ['expired', 'customer', 'price_rose', 'product_changed'] as const;

export const cancelReasonSchema = z.enum(CANCEL_REASONS).meta({ id: 'CancelReason' });

export type CancelReason = z.infer<typeof cancelReasonSchema>;

/** Rule RS6: the reservation pays the lower unit price, and says which one it took. */
export function reservationCharge(
  savedUnitPriceUsdUnits: number,
  currentUnitPriceUsdUnits: number,
): { unitPriceUsdUnits: number; source: 'saved' | 'current' } {
  return currentUnitPriceUsdUnits < savedUnitPriceUsdUnits
    ? { unitPriceUsdUnits: currentUnitPriceUsdUnits, source: 'current' }
    : { unitPriceUsdUnits: savedUnitPriceUsdUnits, source: 'saved' };
}

/** What the order recorded of the player check (rule PV8). */
export const PLAYER_CHECK_STATES = [
  'valid',
  'invalid_confirmed',
  'unchecked_confirmed',
  'none',
] as const;

export const playerCheckStateSchema = z.enum(PLAYER_CHECK_STATES).meta({ id: 'PlayerCheckState' });

export type PlayerCheckState = z.infer<typeof playerCheckStateSchema>;

/** A cached supplier answer (`player_checks.result`, rule PV3). */
export const PLAYER_CHECK_RESULTS = ['valid', 'invalid'] as const;

export type PlayerCheckResult = (typeof PLAYER_CHECK_RESULTS)[number];

/** A cached answer lasts 24 hours when valid and 1 hour when invalid (rule PV3). */
export const PLAYER_CHECK_TTL_MS: Readonly<Record<PlayerCheckResult, number>> = {
  valid: 24 * 60 * 60 * 1_000,
  invalid: 60 * 60 * 1_000,
};

/** The supplier call of a player check gives up after this long (rule PV6). */
export const PLAYER_CHECK_TIMEOUT_MS = 5_000;

export const PLAYER_NAME_MAX_LENGTH = 64;

/**
 * A supplier's in-game name as the store may show it: printable characters only, spaces
 * collapsed, trimmed, at most 64 characters; null when nothing is left.
 */
export function cleanPlayerName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const clean = [
    ...name
      .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  ]
    .slice(0, PLAYER_NAME_MAX_LENGTH)
    .join('')
    .trim();
  return clean === '' ? null : clean;
}

// Attempts, events, refunds ---------------------------------------------------------------------

/** A fulfilment attempt (ADR 0004): one supplier call with its own idempotency key. */
export const ATTEMPT_STATUSES = ['sending', 'pending', 'unknown', 'delivered', 'failed'] as const;

export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES).meta({ id: 'AttemptStatus' });

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

/** Attempts that have no result yet: at most one per order (rule R3). */
export const OPEN_ATTEMPT_STATUSES = [
  'sending',
  'pending',
  'unknown',
] as const satisfies readonly AttemptStatus[];

export function isOpenAttempt(status: AttemptStatus): boolean {
  return (OPEN_ATTEMPT_STATUSES as readonly AttemptStatus[]).includes(status);
}

/** Who gave an attempt its final result (rule F1). */
export const ATTEMPT_RESOLVERS = ['supplier', 'poll', 'webhook', 'admin'] as const;

export const attemptResolverSchema = z.enum(ATTEMPT_RESOLVERS).meta({ id: 'AttemptResolver' });

export type AttemptResolver = z.infer<typeof attemptResolverSchema>;

export const ORDER_EVENT_KINDS = ['status', 'attempt', 'note'] as const;

export const orderEventKindSchema = z.enum(ORDER_EVENT_KINDS).meta({ id: 'OrderEventKind' });

export type OrderEventKind = z.infer<typeof orderEventKindSchema>;

export const ORDER_EVENT_ACTORS = ['customer', 'system', 'supplier', 'admin'] as const;

export const orderEventActorSchema = z.enum(ORDER_EVENT_ACTORS).meta({ id: 'OrderEventActor' });

export type OrderEventActor = z.infer<typeof orderEventActorSchema>;

/** Why units were refunded (rules R5, F1, D5). */
export const REFUND_REASONS = ['no_route', 'routes_exhausted', 'input_rejected', 'admin'] as const;

export const refundReasonSchema = z.enum(REFUND_REASONS).meta({ id: 'RefundReason' });

export type RefundReason = z.infer<typeof refundReasonSchema>;

/** Why the router passed over a route (rules R2, R4): RT4's reasons, then the order's own. */
export const ROUTE_SKIP_REASONS = [
  ...ROUTE_UNUSABLE_REASONS,
  'test_customer',
  'already_tried',
  'unprofitable',
  'balance_below_order',
] as const;

export const routeSkipReasonSchema = z.enum(ROUTE_SKIP_REASONS).meta({ id: 'RouteSkipReason' });

export type RouteSkipReason = z.infer<typeof routeSkipReasonSchema>;

/** Who can reveal a code (rules C2, C3). */
export const CODE_REVEAL_ACTORS = ['customer', 'admin'] as const;

export const codeRevealActorSchema = z.enum(CODE_REVEAL_ACTORS).meta({ id: 'CodeRevealActor' });

// Money (M1–M3) ---------------------------------------------------------------------------------

function safeProduct(units: number, count: number, name: string): number {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new RangeError(`Expected a non-negative safe integer ${name}, got ${units}`);
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`Expected a non-negative safe integer count, got ${count}`);
  }
  const product = BigInt(units) * BigInt(count);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} × count overflows`);
  return Number(product);
}

/** An order's total (rule M1): the unit price times the quantity. */
export function orderTotal(unitPriceUsdUnits: number, quantity: number): number {
  return safeProduct(unitPriceUsdUnits, quantity, 'unit price');
}

/** The refund of undelivered units (rule M3): the unit price paid times the units. */
export function refundAmount(unitPriceUsdUnits: number, units: number): number {
  return safeProduct(unitPriceUsdUnits, units, 'unit price');
}

/** The cost of goods of a delivered attempt (rule M2): the unit cost times the units delivered. */
export function costOfGoods(unitCostUsdUnits: number, units: number): number {
  return safeProduct(unitCostUsdUnits, units, 'unit cost');
}

/**
 * The margin guard per attempt (ADR 0020, rule R2): a route is profitable for the price paid when
 * `unit price − unit cost ≥ the order's minimum margin`; exactly the minimum is profitable.
 */
export function routeProfitable(
  unitPriceUsdUnits: number,
  unitCostUsdUnits: number,
  minMarginUsdUnits: number,
): boolean {
  return unitPriceUsdUnits - unitCostUsdUnits >= minMarginUsdUnits;
}

// Routing (R1–R4) -------------------------------------------------------------------------------

/** Test customers' orders use only these suppliers (rule R4; owner, 2026-10-09). */
export const TEST_ORDER_SUPPLIERS = ['fake', 'manual'] as const satisfies readonly SupplierCode[];

export function supplierServesCustomer(code: SupplierCode, isTestCustomer: boolean): boolean {
  return !isTestCustomer || (TEST_ORDER_SUPPLIERS as readonly SupplierCode[]).includes(code);
}

/**
 * Rule O3: a product's availability for this customer. For a test customer only the routes of
 * `TEST_ORDER_SUPPLIERS` count (rule R4).
 */
export function availabilityForCustomer(
  facts: Omit<AvailabilityFacts, 'usableRouteCostsUsdUnits'>,
  usableRoutes: readonly { supplierCode: SupplierCode; costUsdUnits: number }[],
  isTestCustomer: boolean,
): ProductAvailability {
  return productAvailability({
    ...facts,
    usableRouteCostsUsdUnits: usableRoutes
      .filter((route) => supplierServesCustomer(route.supplierCode, isTestCustomer))
      .map((route) => route.costUsdUnits),
  });
}

/** What the router reads about each of the product's routes, archived ones included. */
export interface CandidateRoute {
  id: string;
  supplierCode: SupplierCode;
  health: SupplierHealthState;
  costUsdUnits: number | null;
  priority: number;
  /** Rule RT4 now; null when usable. */
  unusableReason: RouteUnusableReason | null;
  /** The supplier's newest balance in USD units; null when it reports none in USD. */
  balanceUsdUnits: number | null;
}

/** What the router knows of the order (rule R1). */
export interface CandidateOrder {
  unitPriceUsdUnits: number;
  minMarginUsdUnits: number;
  remainingUnits: number;
  isTestCustomer: boolean;
  /** Routes this order already tried (rule R6). */
  triedRouteIds: readonly string[];
}

/** One route as the router saw it, stored on the attempt (ADR 0005: decisions are recorded). */
export const routeCandidateSchema = z
  .object({
    routeId: z.uuid(),
    supplierCode: supplierCodeSchema,
    tier: routeTierSchema.nullable(),
    costUsdUnits: z.int().nullable(),
    /** 1 for the route chosen, then the order of the others; null for a skipped route. */
    rank: z.int().positive().nullable(),
    skipReason: routeSkipReasonSchema.nullable(),
  })
  .meta({ id: 'RouteCandidate' });

export type RouteCandidate = z.infer<typeof routeCandidateSchema>;

function skipReason(route: CandidateRoute, order: CandidateOrder): RouteSkipReason | null {
  if (route.unusableReason !== null) return route.unusableReason;
  if (!supplierServesCustomer(route.supplierCode, order.isTestCustomer)) return 'test_customer';
  if (order.triedRouteIds.includes(route.id)) return 'already_tried';
  // A usable route has a cost (rule RT4).
  const cost = route.costUsdUnits as number;
  if (!routeProfitable(order.unitPriceUsdUnits, cost, order.minMarginUsdUnits)) {
    return 'unprofitable';
  }
  if (
    route.balanceUsdUnits !== null &&
    route.balanceUsdUnits < costOfGoods(cost, order.remainingUnits)
  ) {
    return 'balance_below_order';
  }
  return null;
}

/**
 * Rules R2 and R4: every route with its rank or skip reason, candidates first in the order of
 * rules RT5–RT6 (tier, cost, priority, supplier code), then the skipped routes. The first entry
 * with a rank is the route to try; none means no candidate is left (rule R5).
 */
export function orderCandidates(
  routes: readonly CandidateRoute[],
  order: CandidateOrder,
): RouteCandidate[] {
  const judged = routes.map((route) => ({ route, reason: skipReason(route, order) }));
  const ranked = orderRoutes(
    judged.filter((entry) => entry.reason === null).map((entry) => entry.route),
  );
  const tierOf = (route: CandidateRoute): RouteTier | null =>
    route.unusableReason === null ? routeTier(route.supplierCode, route.health) : null;
  return [
    ...ranked.map((route, index) => ({
      routeId: route.id,
      supplierCode: route.supplierCode,
      tier: tierOf(route),
      costUsdUnits: route.costUsdUnits,
      rank: index + 1,
      skipReason: null,
    })),
    ...judged
      .filter((entry) => entry.reason !== null)
      .map(({ route, reason }) => ({
        routeId: route.id,
        supplierCode: route.supplierCode,
        tier: tierOf(route),
        costUsdUnits: route.costUsdUnits,
        rank: null,
        skipReason: reason,
      })),
  ];
}

// Policy and polling (F7, MN2) ------------------------------------------------------------------

/** The order policy (owner, 2026-10-09): the newest `order_policy` row is in force. */
export const orderPolicySchema = z
  .object({
    firstPollSeconds: z.int().min(15).max(600),
    fastPollSeconds: z.int().min(15).max(600),
    fastPollMinutes: z.int().min(1).max(60),
    slowPollSeconds: z.int().min(60).max(3_600),
    hardLimitMinutes: z.int().min(5).max(240),
    reviewPollMinutes: z.int().min(5).max(240),
    reviewPollHours: z.int().min(1).max(72),
    manualReminderMinutes: z.int().min(5).max(240),
  })
  .meta({ id: 'OrderPolicy' });

export type OrderPolicy = z.infer<typeof orderPolicySchema>;

/** The seeded policy (S08 "order_policy"). */
export const ORDER_POLICY_DEFAULTS: OrderPolicy = {
  firstPollSeconds: 60,
  fastPollSeconds: 60,
  fastPollMinutes: 10,
  slowPollSeconds: 300,
  hardLimitMinutes: 30,
  reviewPollMinutes: 30,
  reviewPollHours: 24,
  manualReminderMinutes: 15,
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Rule F7: the first poll of an automatic attempt, `firstPollSeconds` after it was sent. */
export function firstPollAt(sentAt: Date, policy: Pick<OrderPolicy, 'firstPollSeconds'>): Date {
  return new Date(sentAt.getTime() + policy.firstPollSeconds * SECOND);
}

/** Rule F7: an automatic attempt still open `hardLimitMinutes` after sending is held. */
export function pastHardLimit(
  sentAt: Date,
  now: Date,
  policy: Pick<OrderPolicy, 'hardLimitMinutes'>,
): boolean {
  return now.getTime() - sentAt.getTime() >= policy.hardLimitMinutes * MINUTE;
}

/**
 * Rule F7: the poll after one made at `now`: every `fastPollSeconds` until `fastPollMinutes` after
 * sending, then every `slowPollSeconds`; once past the hard limit, every `reviewPollMinutes` for
 * `reviewPollHours`. Null when polling is over (the admin decides).
 */
export function nextPollAt(sentAt: Date, now: Date, policy: OrderPolicy): Date | null {
  const elapsed = now.getTime() - sentAt.getTime();
  const hardLimit = policy.hardLimitMinutes * MINUTE;
  if (elapsed >= hardLimit + policy.reviewPollHours * 60 * MINUTE) return null;
  const interval =
    elapsed >= hardLimit
      ? policy.reviewPollMinutes * MINUTE
      : elapsed < policy.fastPollMinutes * MINUTE
        ? policy.fastPollSeconds * SECOND
        : policy.slowPollSeconds * SECOND;
  return new Date(now.getTime() + interval);
}

/** Rule MN2: when a manual attempt's one reminder is due. */
export function manualReminderAt(
  sentAt: Date,
  policy: Pick<OrderPolicy, 'manualReminderMinutes'>,
): Date {
  return new Date(sentAt.getTime() + policy.manualReminderMinutes * MINUTE);
}

// Delivery time (T1) ----------------------------------------------------------------------------

/** Rule T1: the last 50 delivered orders of 30 days; shown from 5. */
export const DELIVERY_STATS_SAMPLE_SIZE = 50;
export const DELIVERY_STATS_SAMPLE_DAYS = 30;
export const DELIVERY_STATS_MIN_SAMPLES = 5;

/** `catalog.ts` holds the shape on each product (it cannot import this file). */
export const deliveryStatsSchema = productSchema.shape.deliveryStats
  .unwrap()
  .meta({ id: 'DeliveryStats' });

export type DeliveryStats = z.infer<typeof deliveryStatsSchema>;

/** Rule T1: median and p90 by nearest rank; null under `DELIVERY_STATS_MIN_SAMPLES`. */
export function deliveryStats(durationsMs: readonly number[]): DeliveryStats | null {
  if (durationsMs.length < DELIVERY_STATS_MIN_SAMPLES) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const rank = (percent: number) =>
    sorted[Math.ceil((sorted.length * percent) / 100) - 1] as number;
  return { medianMs: rank(50), p90Ms: rank(90), count: sorted.length };
}

// Numbers and codes -----------------------------------------------------------------------------

/** Order numbers: `VO-` and 6 characters of the reference alphabet (no 0, O, 1, I or L). */
export const ORDER_NUMBER_ALPHABET = REFERENCE_CODE_ALPHABET;
export const ORDER_NUMBER_LENGTH = 6;
export const ORDER_NUMBER_PREFIX = 'VO-';

const ORDER_NUMBER_PATTERN = new RegExp(
  `^${ORDER_NUMBER_PREFIX}[${ORDER_NUMBER_ALPHABET}]{${ORDER_NUMBER_LENGTH}}$`,
);

/** An order number as typed: lower case and a missing dash are accepted, `VO-XXXXXX` returned. */
export const orderNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/^VO-?/, ORDER_NUMBER_PREFIX))
  .pipe(z.string().regex(ORDER_NUMBER_PATTERN, 'Expected an order number such as VO-7KQ2MX'));

/** A code shorter than this gives no hint: its last 4 characters would be most of it (rule C3). */
export const CODE_HINT_MIN_LENGTH = 12;

/** The hint stored next to an encrypted code: its last 4 characters, or null when too short. */
export function codeHint(code: string): string | null {
  return code.length >= CODE_HINT_MIN_LENGTH ? code.slice(-4) : null;
}

/** A code as shown masked (rules C2, C3): dots, then its hint when it has one. */
export function maskCode(hint: string | null): string {
  return hint === null ? '••••••••' : `••••••${hint}`;
}

/** A code the admin types for a manual delivery (rule D2): 1–200 printable characters. */
export const deliveredCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]+$/u);

// Input fields (S06 CT7, rule O5) ---------------------------------------------------------------

/** A field's value as the customer typed it, before its type's rules. */
const typedValue = z.string().max(200);

/** What a field's value rules read (S06 CT7). */
export type OrderFieldRules = Pick<
  InputField,
  'key' | 'type' | 'required' | 'minLength' | 'maxLength' | 'options'
>;

function fieldValueSchema(field: OrderFieldRules): z.ZodType<string, string> {
  const length = (schema: z.ZodString, max: number) =>
    schema.min(field.minLength ?? 1).max(field.maxLength ?? max);
  switch (field.type) {
    case 'digits':
      return length(z.string().trim(), 32).regex(/^[0-9]+$/);
    case 'text':
      return length(z.string().trim(), 64).regex(/^[^\p{Cc}]+$/u);
    case 'phone':
      return phoneSchema;
    case 'select':
      return z.enum((field.options ?? []).map((option) => option.value) as [string, ...string[]]);
  }
}

/**
 * Rule O5: the values of an order for a game's unarchived input fields (S06 CT7). Required fields
 * must be present; an empty optional field is left out; unknown keys are refused. Values come out
 * trimmed (phones in E.164). Issues carry the field's key as their first path element.
 */
export function orderFieldValuesSchema(
  fields: readonly OrderFieldRules[],
): z.ZodType<Record<string, string>, Record<string, string>> {
  const shape: Record<string, z.ZodType<string | undefined, string | undefined>> = {};
  for (const field of fields) {
    const value = fieldValueSchema(field);
    shape[field.key] = field.required
      ? value
      : z
          .string()
          .optional()
          .transform((typed) => (typed?.trim() ? typed : undefined))
          .pipe(value.optional());
  }
  return z.strictObject(shape).transform((values) => {
    const present: Record<string, string> = {};
    for (const [key, value] of Object.entries(values))
      if (value !== undefined) present[key] = value;
    return present;
  }) as z.ZodType<Record<string, string>, Record<string, string>>;
}

// Customer routes -------------------------------------------------------------------------------

/** `POST /api/orders` (rules O1–O6): the client sends only the price it expects. */
export const createOrderSchema = z
  .object({
    productId: z.uuid(),
    quantity: z.int().min(1).max(MAX_QUANTITY_LIMIT),
    fields: z
      .record(z.string().max(32), typedValue)
      .refine((fields) => Object.keys(fields).length <= MAX_INPUT_FIELDS_PER_GAME, {
        message: `Expected at most ${MAX_INPUT_FIELDS_PER_GAME} fields`,
      })
      .default({}),
    expectedUnitPriceUsdUnits: usdCentsSchema.min(1),
    /** S09 rule RS1: reserve the order when the balance is short instead of refusing it. */
    whenBalanceShort: z.enum(['refuse', 'reserve']).default('refuse'),
    /** S09 rule PV8: the customer confirmed the player id that is not known `valid`. */
    confirmPlayer: z.boolean().default(false),
  })
  .meta({ id: 'CreateOrder' });

export type CreateOrder = z.input<typeof createOrderSchema>;

/** `POST /api/player-checks` (rules PV1, PV2). */
export const playerCheckRequestSchema = createOrderSchema
  .pick({ productId: true, fields: true })
  .meta({ id: 'PlayerCheckRequest' });

export type PlayerCheckRequest = z.input<typeof playerCheckRequestSchema>;

/** Rule PV6: the answer of a player check. */
export const playerCheckSchema = z
  .discriminatedUnion('result', [
    z.object({ result: z.literal('valid'), playerName: z.string().nullable() }),
    z.object({ result: z.literal('invalid') }),
    z.object({ result: z.literal('unavailable'), reason: z.enum(['quota', 'supplier']) }),
    z.object({ result: z.literal('not_supported') }),
  ])
  .meta({ id: 'PlayerCheck' });

export type PlayerCheck = z.infer<typeof playerCheckSchema>;

/** The stream's `order` event (rule LT2): ids and status only, never fields or amounts. */
export const orderStreamItemSchema = z
  .object({ orderId: z.uuid(), status: orderStatusSchema, stage: orderStageSchema })
  .meta({ id: 'OrderStreamItem' });

export type OrderStreamItem = z.infer<typeof orderStreamItemSchema>;

const orderGame = z.object({ id: z.uuid(), slug: z.string(), nameAr: z.string() });

/** One order in "طلباتي". */
export const orderSummarySchema = z
  .object({
    id: z.uuid(),
    number: z.string(),
    stage: orderStageSchema,
    productNameAr: z.string(),
    game: orderGame.extend({ cover: catalogImageSchema.nullable() }),
    quantity: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    /** The pounds shown at purchase (rule O6), display only; null without a rate then. */
    totalSypUnits: z.int().nullable(),
    /** A reservation's deadline (rule RS1); null for an order created paid. */
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'OrderSummary' });

export type OrderSummary = z.infer<typeof orderSummarySchema>;

/** `GET /api/orders`: newest first, 20 a page. */
export const orderListQuerySchema = cursorQuerySchema
  .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .meta({ id: 'OrderListQuery' });

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderPageSchema = cursorPageSchema(orderSummarySchema, 'OrderPage');

export type OrderPage = z.infer<typeof orderPageSchema>;

const orderFieldValue = z.object({ key: z.string(), labelAr: z.string(), value: z.string() });

/** A code of a code product, masked: its value only comes from the reveal route (rule C2). */
export const orderCodeSchema = z
  .object({
    id: z.uuid(),
    position: z.int().positive(),
    masked: z.string(),
    firstRevealedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'OrderCode' });

export type OrderCode = z.infer<typeof orderCodeSchema>;

/** `GET /api/orders/:id`: never the supplier, costs, attempts or internal reasons (rule O13). */
export const orderSchema = z
  .object({
    id: z.uuid(),
    number: z.string(),
    stage: orderStageSchema,
    product: z.object({
      id: z.uuid(),
      nameAr: z.string(),
      kind: productKindSchema,
      regionAr: z.string().nullable(),
      redemptionAr: z.string().nullable(),
    }),
    game: orderGame.extend({ cover: catalogImageSchema.nullable() }),
    fields: z.array(orderFieldValue),
    quantity: z.int().positive(),
    deliveredQuantity: z.int().nonnegative(),
    refundedQuantity: z.int().nonnegative(),
    unitPriceUsdUnits: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    totalSypUnits: z.int().nullable(),
    refundedUsdUnits: z.int().nonnegative(),
    refundReason: refundReasonSchema.nullable(),
    /** Rule LT1, oldest first. */
    timeline: z.array(z.object({ step: orderTimelineStepSchema, at: z.iso.datetime() })),
    codes: z.array(orderCodeSchema),
    /** A reservation's deadline (rule RS1), kept after payment. */
    expiresAt: z.iso.datetime().nullable(),
    cancelReason: cancelReasonSchema.nullable(),
    /** The in-game name of a validated order (rule LT3). */
    playerName: z.string().nullable(),
    /** The product's delivery time (S08 rule T1), shown while the order is open (rule LT3). */
    deliveryStats: deliveryStatsSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Order' });

export type Order = z.infer<typeof orderSchema>;

/** `POST /api/orders/:id/codes/:codeId/reveal` (rule C2). */
export const revealedCodeSchema = z
  .object({ code: z.string(), firstRevealedAt: z.iso.datetime() })
  .meta({ id: 'RevealedCode' });

export type RevealedCode = z.infer<typeof revealedCodeSchema>;

// Admin routes ----------------------------------------------------------------------------------

/** The tabs of the admin's order list, each a set of statuses or open attempts. */
export const ADMIN_ORDER_TABS = [
  'all',
  'review',
  'manual',
  'active',
  'delivered',
  'refunded',
] as const;

export const adminOrderTabSchema = z.enum(ADMIN_ORDER_TABS).meta({ id: 'AdminOrderTab' });

export type AdminOrderTab = z.infer<typeof adminOrderTabSchema>;

/** The statuses of each tab; `manual` is the orders with an open manual attempt. */
export const ADMIN_ORDER_TAB_STATUSES: Readonly<
  Record<Exclude<AdminOrderTab, 'all' | 'manual'>, readonly OrderStatus[]>
> = {
  review: ['needs_review'],
  active: ['paid', 'sent_to_supplier', 'failed'],
  delivered: ['delivered'],
  refunded: ['partially_refunded', 'refunded'],
};

const booleanFilter = z.enum(['true', 'false']).optional();

/** `GET /api/admin/orders`: newest first, filters and page in the URL. */
export const adminOrderListQuerySchema = pageQuerySchema
  .extend({
    tab: adminOrderTabSchema.default('all'),
    status: orderStatusSchema.optional(),
    /** An order number (any case, with or without the dash) or part of the customer's email. */
    q: z.string().trim().min(1).max(100).optional(),
    productId: z.uuid().optional(),
    supplier: supplierCodeSchema.optional(),
    test: booleanFilter,
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .meta({ id: 'AdminOrderListQuery' });

export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

const orderCustomer = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  isTest: z.boolean(),
});

export const adminOrderSummarySchema = z
  .object({
    id: z.uuid(),
    number: z.string(),
    status: orderStatusSchema,
    customer: orderCustomer,
    product: z.object({ id: z.uuid(), nameAr: z.string() }),
    game: z.object({ id: z.uuid(), nameAr: z.string() }),
    quantity: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    /** The supplier of the open attempt, else of the newest one; null before routing. */
    supplierCode: supplierCodeSchema.nullable(),
    /** The open attempt is the manual supplier's (rule MN1). */
    manualWaiting: z.boolean(),
    /** Since the last status change. */
    since: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminOrderSummary' });

export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;

export const adminOrderPageSchema = pagedListSchema(adminOrderSummarySchema, 'AdminOrderPage');

export type AdminOrderPage = z.infer<typeof adminOrderPageSchema>;

/** `GET /api/admin/orders/counts`: the navigation badge. */
export const adminOrderCountsSchema = z
  .object({ needsReview: z.int().nonnegative(), manualWaiting: z.int().nonnegative() })
  .meta({ id: 'AdminOrderCounts' });

export type AdminOrderCounts = z.infer<typeof adminOrderCountsSchema>;

export const WEBHOOK_EVENT_RESULTS = [
  'applied',
  'same_result',
  'unknown_key',
  'conflict',
  'malformed',
] as const;

export const webhookEventResultSchema = z
  .enum(WEBHOOK_EVENT_RESULTS)
  .meta({ id: 'WebhookEventResult' });

export type WebhookEventResult = z.infer<typeof webhookEventResultSchema>;

export const fulfilmentAttemptSchema = z
  .object({
    id: z.uuid(),
    routeId: z.uuid(),
    supplierCode: supplierCodeSchema,
    supplierNameAr: z.string(),
    /** The supplier's own offer id, and its name. */
    offerId: z.string(),
    offerName: z.string(),
    quantity: z.int().positive(),
    deliveredQuantity: z.int().nonnegative(),
    unitCostUsdUnits: z.int().positive(),
    status: attemptStatusSchema,
    supplierOrderId: z.string().nullable(),
    failureReason: z.string().nullable(),
    inputRejected: z.boolean(),
    supplierErrorCode: z.string().nullable(),
    candidates: z.array(routeCandidateSchema),
    resolvedBy: attemptResolverSchema.nullable(),
    adminReason: z.string().nullable(),
    pollCount: z.int().nonnegative(),
    sentAt: z.iso.datetime().nullable(),
    nextPollAt: z.iso.datetime().nullable(),
    resolvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    webhookEvents: z.array(
      z.object({
        id: z.uuid(),
        eventId: z.string(),
        result: webhookEventResultSchema.nullable(),
        processedAt: z.iso.datetime().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'FulfilmentAttempt' });

export type FulfilmentAttempt = z.infer<typeof fulfilmentAttemptSchema>;

export const orderEventSchema = z
  .object({
    id: z.uuid(),
    kind: orderEventKindSchema,
    fromStatus: orderStatusSchema.nullable(),
    toStatus: orderStatusSchema.nullable(),
    actor: orderEventActorSchema,
    attemptId: z.uuid().nullable(),
    reason: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'OrderEvent' });

export type OrderEvent = z.infer<typeof orderEventSchema>;

/** The admin's view of a code: masked, with who revealed it when (rule C3). */
export const adminOrderCodeSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    position: z.int().positive(),
    masked: z.string(),
    reveals: z.array(
      z.object({
        actor: codeRevealActorSchema,
        ipAddress: z.string().nullable(),
        userAgent: z.string().nullable(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'AdminOrderCode' });

/** What the admin may decide on the order now (rule D1). */
export const orderDecisionsSchema = z
  .object({
    /** The open attempt to poll or resolve; null with none. */
    attemptId: z.uuid().nullable(),
    poll: z.boolean(),
    resolve: z.boolean(),
    refund: z.boolean(),
  })
  .meta({ id: 'OrderDecisions' });

export type OrderDecisions = z.infer<typeof orderDecisionsSchema>;

/**
 * Rule D1: an open manual attempt may be resolved; an order in `needs_review` may be refunded,
 * its open attempt resolved and, when automatic, polled again (D4).
 */
export function orderDecisions(
  status: OrderStatus,
  openAttempt: { id: string; supplierCode: SupplierCode } | null,
): OrderDecisions {
  const held = status === 'needs_review';
  const manual = openAttempt?.supplierCode === 'manual';
  return {
    attemptId: openAttempt?.id ?? null,
    poll: held && openAttempt !== null && !manual,
    resolve: openAttempt !== null && (held || manual),
    refund: held,
  };
}

/** `GET /api/admin/orders/:id`. */
export const adminOrderSchema = z
  .object({
    id: z.uuid(),
    number: z.string(),
    status: orderStatusSchema,
    customer: orderCustomer,
    product: z.object({ id: z.uuid(), nameAr: z.string(), kind: productKindSchema }),
    game: z.object({ id: z.uuid(), nameAr: z.string() }),
    fields: z.array(orderFieldValue),
    quantity: z.int().positive(),
    deliveredQuantity: z.int().nonnegative(),
    refundedQuantity: z.int().nonnegative(),
    unitPriceUsdUnits: z.int().positive(),
    totalUsdUnits: z.int().positive(),
    totalSypUnits: z.int().nullable(),
    minMarginUsdUnits: z.int().nonnegative(),
    refundedUsdUnits: z.int().nonnegative(),
    refundReason: refundReasonSchema.nullable(),
    /** Rule AD3: the reservation, the cancel reason and the player check. */
    reservedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    cancelReason: cancelReasonSchema.nullable(),
    playerCheck: playerCheckStateSchema,
    playerName: z.string().nullable(),
    paidAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    reviewSince: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    decisions: orderDecisionsSchema,
    /** Newest first. */
    attempts: z.array(fulfilmentAttemptSchema),
    /** Oldest first. */
    events: z.array(orderEventSchema),
    journals: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(['purchase', 'refund', 'cost_of_goods']),
        /** The amount the journal moved, positive. */
        amountUsdUnits: z.int().nonnegative(),
        createdAt: z.iso.datetime(),
      }),
    ),
    codes: z.array(adminOrderCodeSchema),
  })
  .meta({ id: 'AdminOrder' });

export type AdminOrder = z.infer<typeof adminOrderSchema>;

/** Every admin decision carries a reason (rule D1). */
const decisionReason = z
  .string()
  .trim()
  .min(5)
  .max(500)
  .regex(/^[^\p{Cc}]+$/u);

/** `POST /api/admin/orders/:id/attempts/:attemptId/poll` (rule D4). */
export const pollAttemptSchema = z.object({ reason: decisionReason }).meta({ id: 'PollAttempt' });

export type PollAttempt = z.infer<typeof pollAttemptSchema>;

/** `POST /api/admin/orders/:id/attempts/:attemptId/resolve` (rules D2, D3). */
export const resolveAttemptSchema = z
  .discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('delivered'),
      quantity: z.int().min(1).max(MAX_QUANTITY_LIMIT),
      /** Exactly `quantity` codes for a code product, none for a top-up (`CODES_COUNT_MISMATCH`). */
      codes: z.array(deliveredCodeSchema).max(MAX_QUANTITY_LIMIT).default([]),
      reason: decisionReason,
    }),
    z.object({ outcome: z.literal('failed'), reason: decisionReason }),
  ])
  .meta({ id: 'ResolveAttempt' });

export type ResolveAttempt = z.input<typeof resolveAttemptSchema>;

/** `POST /api/admin/orders/:id/refund` (rule D5). */
export const refundOrderSchema = z.object({ reason: decisionReason }).meta({ id: 'RefundOrder' });

export type RefundOrder = z.infer<typeof refundOrderSchema>;

/** `POST /api/admin/orders/:id/codes/:codeId/reveal` (rule C3). */
export const adminRevealedCodeSchema = z
  .object({ code: z.string() })
  .meta({ id: 'AdminRevealedCode' });

export type AdminRevealedCode = z.infer<typeof adminRevealedCodeSchema>;
