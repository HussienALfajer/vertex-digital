import { z } from 'zod';
import { productAvailabilitySchema } from './catalog.js';
import { pagedListSchema, pageQuerySchema } from './lists.js';
import {
  CURRENCY_SCALE,
  ceilToStep,
  exchangeRateSchema,
  USD_CENT,
  usdCentsSchema,
} from './money.js';
import { supplierCodeSchema } from './suppliers.js';

/*
 * The pricing engine (S06, F10; ADR 0020), owned by the api `pricing` module: margin rules per
 * scope and the pure price math. S07 stores prices computed here from route costs; S08 checks the
 * margin guard at pay and routing time.
 */

/** Rule scopes, from the least to the most specific (rule PR2). */
export const MARGIN_SCOPES = ['global', 'category', 'game', 'product'] as const;

export const marginScopeSchema = z.enum(MARGIN_SCOPES).meta({ id: 'MarginScope' });

export type MarginScope = z.infer<typeof marginScopeSchema>;

/** Basis points per 100% (1000 = 10%). */
export const BASIS_POINTS = 10_000;

/** The bounds of a rule's values (rule PR1): percent 0–100%, fixed $0–$50, minimum $0.01–$50. */
export const MARGIN_MAX_USD_UNITS = 50 * CURRENCY_SCALE.USD;

/** The costs a preview takes (rule PR10, edge case 11): 1 unit to $10,000. */
export const PREVIEW_MAX_COST_USD_UNITS = 10_000 * CURRENCY_SCALE.USD;

/** A rule's values (rule PR1). */
export const marginRuleValuesSchema = z
  .object({
    percentBp: z.int().min(0).max(BASIS_POINTS),
    fixedUsdUnits: usdCentsSchema.max(MARGIN_MAX_USD_UNITS),
    minMarginUsdUnits: usdCentsSchema.min(USD_CENT).max(MARGIN_MAX_USD_UNITS),
  })
  .meta({ id: 'MarginRuleValues' });

export type MarginRuleValues = z.infer<typeof marginRuleValuesSchema>;

/** What a rule or a preview applies to: a target id for every scope but `global`. */
const target = { scope: marginScopeSchema, targetId: z.uuid().nullable().optional() };

const targetMatchesScope = (value: { scope: MarginScope; targetId?: string | null | undefined }) =>
  value.scope === 'global' ? value.targetId == null : value.targetId != null;

const targetMessage = {
  message: 'Expected a targetId for every scope but global, and none for global',
  path: ['targetId'],
};

/** A live rule (`GET /api/admin/pricing/rules`). */
export const marginRuleSchema = marginRuleValuesSchema
  .extend({
    id: z.uuid(),
    scope: marginScopeSchema,
    targetId: z.uuid().nullable(),
    /** The target's Arabic name; null for the global rule. */
    targetName: z.string().nullable(),
    /** The target is archived: the rule applies again on restore (edge case 3). */
    targetArchived: z.boolean(),
    /** Unarchived products this rule governs (rule PR2). */
    productCount: z.int().nonnegative(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarginRule' });

export type MarginRule = z.infer<typeof marginRuleSchema>;

/** `PUT /api/admin/pricing/rules` (rule PR9): the live rule of the target, created or replaced. */
export const setMarginRuleSchema = marginRuleValuesSchema
  .extend(target)
  .refine(targetMatchesScope, targetMessage)
  .meta({ id: 'SetMarginRule' });

export type SetMarginRule = z.input<typeof setMarginRuleSchema>;

/** `POST /api/admin/pricing/preview` (rule PR10). */
export const pricingPreviewRequestSchema = z
  .object({
    target: z.object(target).refine(targetMatchesScope, targetMessage),
    costUsdUnits: z.int().min(1).max(PREVIEW_MAX_COST_USD_UNITS),
    /** Draft values from the rule form; without them the rule that applies to the target. */
    values: marginRuleValuesSchema.optional(),
  })
  .meta({ id: 'PricingPreviewRequest' });

export type PricingPreviewRequest = z.input<typeof pricingPreviewRequestSchema>;

/** The savings against an official price (rule PR7). */
export const savingsSchema = z
  .object({
    amountUsdUnits: z.int().positive(),
    /** Whole percent rounded down; null below 1%. */
    percent: z.int().min(1).max(99).nullable(),
  })
  .meta({ id: 'Savings' });

export type Savings = z.infer<typeof savingsSchema>;

export const pricingPreviewSchema = z
  .object({
    /** The values used: the draft, or the rule that applies. */
    rule: marginRuleValuesSchema,
    /** Where the rule comes from: the scope of the live rule found, or null for a draft. */
    ruleScope: marginScopeSchema.nullable(),
    ruleId: z.uuid().nullable(),
    costUsdUnits: z.int().positive(),
    priceUsdUnits: z.int().positive(),
    marginUsdUnits: z.int().positive(),
    /** The margin in basis points of the price, rounded down. */
    marginBp: z.int().nonnegative(),
    /** The SYP price at the current rate and step (rule PR8); null without a rate. */
    priceSypUnits: z.int().nonnegative().nullable(),
    rate: exchangeRateSchema.nullable(),
    /** A product target's official price, or null. */
    officialPriceUsdUnits: z.int().positive().nullable(),
    /** Null when there is no official price or no saving (edge case 6). */
    savings: savingsSchema.nullable(),
  })
  .meta({ id: 'PricingPreview' });

export type PricingPreview = z.infer<typeof pricingPreviewSchema>;

function positiveUnits(units: number, name: string): bigint {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new RangeError(`Expected a positive safe integer ${name}, got ${units}`);
  }
  return BigInt(units);
}

/**
 * The price for a route cost under a rule (rule PR3): `markup = ⌈cost × percent⌉`, then
 * `max(cost + markup + fixed, cost + minimum margin)` rounded **up** to whole cents. Integer
 * math only, rounding only upward, so the margin is never below the minimum (rule PR4).
 */
export function priceFromCost(costUsdUnits: number, rule: MarginRuleValues): number {
  const cost = positiveUnits(costUsdUnits, 'cost');
  const percent = BigInt(rule.percentBp);
  const scale = BigInt(BASIS_POINTS);
  const markup = (cost * percent + scale - 1n) / scale;
  const withMarkup = cost + markup + BigInt(rule.fixedUsdUnits);
  const withMinimum = cost + BigInt(rule.minMarginUsdUnits);
  const raw = withMarkup > withMinimum ? withMarkup : withMinimum;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Price exceeds the safe range');
  return ceilToStep(Number(raw), USD_CENT);
}

/**
 * The margin guard (rule PR5, ADR 0020): a route with this cost is profitable for this price when
 * the margin is at least the rule's minimum; exactly the minimum is profitable.
 */
export function isProfitable(
  priceUsdUnits: number,
  costUsdUnits: number,
  rule: Pick<MarginRuleValues, 'minMarginUsdUnits'>,
): boolean {
  return priceUsdUnits - costUsdUnits >= rule.minMarginUsdUnits;
}

/** The margin of a price in basis points of the price, rounded down. */
export function marginBasisPoints(priceUsdUnits: number, costUsdUnits: number): number {
  const price = positiveUnits(priceUsdUnits, 'price');
  const margin = price - BigInt(costUsdUnits);
  if (margin <= 0n) return 0;
  return Number((margin * BigInt(BASIS_POINTS)) / price);
}

/** Where a product, game or category sits; the global target has none. */
export interface PricingPath {
  productId?: string;
  gameId?: string;
  categoryId?: string;
}

/**
 * The rule that applies to a path (rule PR2): the first live rule among its product, its game,
 * its category, then the global rule. A rule replaces its parent entirely.
 */
export function resolveMarginRule<Rule extends { scope: MarginScope; targetId: string | null }>(
  rules: readonly Rule[],
  path: PricingPath,
): Rule {
  const targets: Record<MarginScope, string | null | undefined> = {
    product: path.productId,
    game: path.gameId,
    category: path.categoryId,
    global: null,
  };
  for (const scope of [...MARGIN_SCOPES].reverse()) {
    const id = targets[scope];
    if (id === undefined) continue;
    const rule = rules.find((candidate) => candidate.scope === scope && candidate.targetId === id);
    if (rule) return rule;
  }
  throw new Error('No global margin rule: it always exists (rule PR2)');
}

/**
 * The savings of a price against an official price (rule PR7): only when the official price is
 * known and above the price; the percent rounded down, shown from 1%.
 */
export function savings(
  priceUsdUnits: number,
  officialPriceUsdUnits: number | null,
): Savings | null {
  if (officialPriceUsdUnits === null || priceUsdUnits >= officialPriceUsdUnits) return null;
  const amountUsdUnits = officialPriceUsdUnits - priceUsdUnits;
  const percent = Number(
    (BigInt(amountUsdUnits) * 100n) / positiveUnits(officialPriceUsdUnits, 'official price'),
  );
  return { amountUsdUnits, percent: percent >= 1 ? percent : null };
}

// Stored prices and reviews (S07, with F09; ADR 0021) -------------------------------------------

/** Why a `product_prices` row was written (rule P2). */
export const PRICE_CHANGE_CAUSES = [
  'cost_sync',
  'route_change',
  'rule_change',
  'review_accepted',
  'margin_adjusted',
] as const;

export const priceChangeCauseSchema = z.enum(PRICE_CHANGE_CAUSES).meta({ id: 'PriceChangeCause' });

export type PriceChangeCause = z.infer<typeof priceChangeCauseSchema>;

export const PRICE_REVIEW_STATUSES = [
  'open',
  'accepted',
  'margin_adjusted',
  'paused',
  'superseded',
] as const;

export const priceReviewStatusSchema = z
  .enum(PRICE_REVIEW_STATUSES)
  .meta({ id: 'PriceReviewStatus' });

export type PriceReviewStatus = z.infer<typeof priceReviewStatusSchema>;

/** A cost change in basis points of the cost before, signed, rounded toward zero. */
export function costChangeBasisPoints(
  costBeforeUsdUnits: number,
  costAfterUsdUnits: number,
): number {
  const before = positiveUnits(costBeforeUsdUnits, 'cost before');
  const change = BigInt(costAfterUsdUnits) - before;
  return Number((change * BigInt(BASIS_POINTS)) / before);
}

/**
 * Rule P3 (ADR 0021): a synced cost change needs review when it moves the cost by more than the
 * threshold, either way, from the cost the current price was built on. Exactly the threshold
 * applies at once.
 */
export function needsReview(
  basisCostThenUsdUnits: number,
  costNowUsdUnits: number,
  thresholdBp: number,
): boolean {
  const then = positiveUnits(basisCostThenUsdUnits, 'cost then');
  const now = BigInt(costNowUsdUnits);
  const change = now > then ? now - then : then - now;
  return change * BigInt(BASIS_POINTS) > BigInt(thresholdBp) * then;
}

/** One stored price (`GET /api/admin/catalog/products/:id/prices`). */
export const productPriceSchema = marginRuleValuesSchema
  .extend({
    id: z.uuid(),
    priceUsdUnits: z.int().positive(),
    costUsdUnits: z.int().positive(),
    routeId: z.uuid(),
    supplierCode: supplierCodeSchema,
    ruleId: z.uuid(),
    cause: priceChangeCauseSchema,
    reviewId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ProductPrice' });

export type ProductPrice = z.infer<typeof productPriceSchema>;

export const productPricePageSchema = pagedListSchema(productPriceSchema, 'ProductPricePage');

export type ProductPricePage = z.infer<typeof productPricePageSchema>;

/** A review as `/pricing/reviews` lists it. */
export const priceReviewSchema = z
  .object({
    id: z.uuid(),
    productId: z.uuid(),
    productNameAr: z.string(),
    gameId: z.uuid(),
    gameNameAr: z.string(),
    supplierCode: supplierCodeSchema,
    supplierNameAr: z.string(),
    routeId: z.uuid(),
    costBeforeUsdUnits: z.int().positive(),
    costAfterUsdUnits: z.int().positive(),
    changeBp: z.int(),
    priceBeforeUsdUnits: z.int().positive(),
    proposedPriceUsdUnits: z.int().positive(),
    /** The held price's margin over the cost now; negative when it sells below cost. */
    heldMarginUsdUnits: z.int(),
    proposedMarginUsdUnits: z.int(),
    status: priceReviewStatusSchema,
    availability: productAvailabilitySchema,
    decidedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PriceReview' });

export type PriceReview = z.infer<typeof priceReviewSchema>;

export const priceReviewListQuerySchema = pageQuerySchema
  .extend({
    status: priceReviewStatusSchema.default('open'),
    supplier: supplierCodeSchema.optional(),
  })
  .meta({ id: 'PriceReviewListQuery' });

export type PriceReviewListQuery = z.infer<typeof priceReviewListQuerySchema>;

export const priceReviewPageSchema = pagedListSchema(priceReviewSchema, 'PriceReviewPage');

export type PriceReviewPage = z.infer<typeof priceReviewPageSchema>;

/** `POST /api/admin/pricing/reviews/decide` (rule P4): each review decided on its own. */
export const decideReviewsSchema = z
  .object({
    decisions: z
      .array(
        z.object({
          reviewId: z.uuid(),
          action: z.enum(['accept', 'pause']),
          /** The proposed price the admin saw; an accept is refused when it changed. */
          expectedPriceUsdUnits: z.int().positive().optional(),
        }),
      )
      .min(1)
      .max(100)
      .refine(
        (decisions) => new Set(decisions.map((item) => item.reviewId)).size === decisions.length,
        'Expected each review once',
      ),
  })
  .meta({ id: 'DecideReviews' });

export type DecideReviews = z.infer<typeof decideReviewsSchema>;

export const decideReviewsResultSchema = z
  .object({
    results: z.array(
      z.object({
        reviewId: z.uuid(),
        result: z.enum(['accepted', 'paused', 'refused']),
        errorCode: z.enum(['NOT_FOUND', 'REVIEW_CLOSED', 'REVIEW_STALE']).optional(),
        /** With `REVIEW_STALE`: the price an accept would give now; null with no usable route. */
        proposedPriceUsdUnits: z.int().positive().nullable().optional(),
      }),
    ),
  })
  .meta({ id: 'DecideReviewsResult' });

export type DecideReviewsResult = z.infer<typeof decideReviewsResultSchema>;
