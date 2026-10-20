import { z } from 'zod';
import { productAvailabilitySchema, SAVINGS_WARNING_PERCENT } from './catalog.js';
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
  const rule = mostSpecificRule(rules, path);
  if (!rule) throw new Error('No global margin rule: it always exists (rule PR2)');
  return rule;
}

/** The first rule among the path's product, game, category, then global; none when absent. */
function mostSpecificRule<Rule extends { scope: MarginScope; targetId: string | null }>(
  rules: readonly Rule[],
  path: PricingPath,
): Rule | undefined {
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
  return undefined;
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

/**
 * Edge case 7: the saving is more than `SAVINGS_WARNING_PERCENT` of the official price, compared
 * exactly, not through the percent shown (rounded down: 50.1% shows 50; audit F8-8).
 */
export function savingsWarning(
  priceUsdUnits: number,
  officialPriceUsdUnits: number | null,
): boolean {
  const found = savings(priceUsdUnits, officialPriceUsdUnits);
  if (!found || officialPriceUsdUnits === null) return false;
  return (
    BigInt(found.amountUsdUnits) * 100n >
    BigInt(officialPriceUsdUnits) * BigInt(SAVINGS_WARNING_PERCENT)
  );
}

// Stored prices and reviews (S07, with F09; ADR 0021) -------------------------------------------

/** Why a `product_prices` row was written (rule P2). */
export const PRICE_CHANGE_CAUSES = [
  'cost_sync',
  'route_change',
  'rule_change',
  'review_accepted',
  'margin_adjusted',
  /** S20 RP3: a list created or archived, a fixed price set or archived, the backfill. */
  'list_change',
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

// Price lists (S20, F29; ADR 0035) ---------------------------------------------------------------

/** A list's kind (S20 LS1): three seeded roots and the admin's custom lists. */
export const PRICE_LIST_KINDS = ['retail', 'wholesale', 'cost', 'custom'] as const;

export const priceListKindSchema = z.enum(PRICE_LIST_KINDS).meta({ id: 'PriceListKind' });

export type PriceListKind = z.infer<typeof priceListKindSchema>;

/**
 * The seeded root lists' fixed ids (S20 data, migration 0076): one live list per root kind, never
 * archived, so these ids hold for good.
 */
export const ROOT_PRICE_LIST_IDS = {
  retail: '01a15a8c-b310-7513-8c14-09e5262ac878',
  wholesale: '01a15a8c-b312-75f3-92d2-65b29d838051',
  cost: '01a15a8c-b312-75f3-92d2-691f7e3bf413',
} as const satisfies Record<Exclude<PriceListKind, 'custom'>, string>;

/** S20 LS1: unarchived custom lists at most. */
export const PRICE_LISTS_MAX_CUSTOM = 20;

/** S20 LS3: a list and its parents, at most this many. */
export const PRICE_LIST_MAX_DEPTH = 5;

/** What a customer is told about their prices (S20 AT4): never a list's name, rule or cost. */
export const PRICE_KINDS = ['retail', 'wholesale', 'special'] as const;

export const priceKindSchema = z.enum(PRICE_KINDS).meta({ id: 'PriceKind' });

export type PriceKind = z.infer<typeof priceKindSchema>;

/** S20 AT4: the cost list and custom lists read "سعر خاص". */
export function priceKindOf(kind: PriceListKind): PriceKind {
  return kind === 'cost' || kind === 'custom' ? 'special' : kind;
}

/** Where a list's price comes from (S20 LP1, LP2). */
export const PRICE_SOURCES = ['rule', 'fixed', 'fixed_fallback', 'retail_cap'] as const;

export const priceSourceSchema = z.enum(PRICE_SOURCES).meta({ id: 'PriceSource' });

export type PriceSource = z.infer<typeof priceSourceSchema>;

/** An account's type (S20 AT1): what the person sees and the limits tier. */
export const ACCOUNT_TYPES = ['customer', 'merchant'] as const;

export const accountTypeSchema = z.enum(ACCOUNT_TYPES).meta({ id: 'AccountType' });

export type AccountType = z.infer<typeof accountTypeSchema>;

/**
 * S20 AT1: the list an account pays, its assigned list, else retail for a customer and wholesale
 * for a merchant.
 */
export function effectivePriceListId(account: {
  accountType: AccountType;
  priceListId: string | null;
}): string {
  if (account.priceListId !== null) return account.priceListId;
  return account.accountType === 'merchant'
    ? ROOT_PRICE_LIST_IDS.wholesale
    : ROOT_PRICE_LIST_IDS.retail;
}

/**
 * S20 LS3: the list, then its parents up to its root, as ids. Throws on an unknown list or a chain
 * deeper than `PRICE_LIST_MAX_DEPTH` (parents are fixed at creation, so neither can happen).
 */
export function listChain(
  lists: readonly { id: string; parentListId: string | null }[],
  listId: string,
): string[] {
  const chain: string[] = [];
  let id: string | null = listId;
  while (id !== null) {
    const found = lists.find((list) => list.id === id);
    if (!found) throw new Error(`Unknown price list ${id}`);
    if (chain.length === PRICE_LIST_MAX_DEPTH) {
      throw new Error(`Price list ${listId} is deeper than ${PRICE_LIST_MAX_DEPTH}`);
    }
    chain.push(found.id);
    id = found.parentListId;
  }
  return chain;
}

/** What `resolveListEntry` found for a product on a list. */
export interface ListEntry<Rule, Fixed> {
  /** The list's own fixed price or its nearest parent's; null when a rule applies. */
  fixed: Fixed | null;
  /** The rule that applies, or with a fixed price its guarding rule. */
  rule: Rule;
  /** The list in the chain that supplied the entry (the fixed price's, or the rule's). */
  listId: string;
}

/**
 * S20 LS4 (decision 5): walking the chain from the list itself, the first list with a live fixed
 * price for the product, or else a product, game, category or global rule, supplies the entry.
 * Within a list a fixed price beats its rules; across lists the nearer list wins whatever its
 * specificity. A fixed price's guarding rule is the rule the same walk finds from its list onward
 * with fixed prices skipped. Throws when the chain's root has no global rule (it always has, LS2).
 */
export function resolveListEntry<
  Rule extends { priceListId: string; scope: MarginScope; targetId: string | null },
  Fixed extends { priceListId: string; productId: string },
>(
  chain: readonly string[],
  entries: { rules: readonly Rule[]; fixedPrices: readonly Fixed[] },
  path: PricingPath & { productId: string },
): ListEntry<Rule, Fixed> {
  const ruleFrom = (start: number): Rule => {
    for (const listId of chain.slice(start)) {
      const rule = mostSpecificRule(
        entries.rules.filter((candidate) => candidate.priceListId === listId),
        path,
      );
      if (rule) return rule;
    }
    throw new Error('No global margin rule on the root list (S20 LS2)');
  };
  for (const [index, listId] of chain.entries()) {
    const fixed = entries.fixedPrices.find(
      (candidate) => candidate.priceListId === listId && candidate.productId === path.productId,
    );
    if (fixed) return { fixed, rule: ruleFrom(index), listId };
    const rule = mostSpecificRule(
      entries.rules.filter((candidate) => candidate.priceListId === listId),
      path,
    );
    if (rule) return { fixed: null, rule, listId };
  }
  throw new Error('No global margin rule on the root list (S20 LS2)');
}

/** A list's price for a cost (S20 LP1–LP4). */
export interface ListPrice {
  priceUsdUnits: number;
  source: PriceSource;
  /** The minimum margin guarding the price: the rule's, or retail's when capped. */
  minMarginUsdUnits: number;
}

/**
 * S20 LP1–LP4 for one list and product at the basis cost:
 * - a rule: `priceFromCost` (PR3), source `rule`;
 * - a fixed price covering cost plus its guarding rule's minimum margin: the fixed price, source
 *   `fixed`; otherwise the guarding rule's price, source `fixed_fallback` (decision 6);
 * - every list but retail (`retail` given): above the retail price, the retail price, source
 *   `retail_cap`, guarded by retail's minimum margin (decision 3).
 */
export function listPrice(
  costUsdUnits: number,
  entry: { fixedPriceUsdUnits: number | null; rule: MarginRuleValues },
  retail: { priceUsdUnits: number; minMarginUsdUnits: number } | null,
): ListPrice {
  let own: ListPrice;
  if (entry.fixedPriceUsdUnits === null) {
    own = {
      priceUsdUnits: priceFromCost(costUsdUnits, entry.rule),
      source: 'rule',
      minMarginUsdUnits: entry.rule.minMarginUsdUnits,
    };
  } else {
    const covered = isProfitable(entry.fixedPriceUsdUnits, costUsdUnits, entry.rule);
    own = {
      priceUsdUnits: covered ? entry.fixedPriceUsdUnits : priceFromCost(costUsdUnits, entry.rule),
      source: covered ? 'fixed' : 'fixed_fallback',
      minMarginUsdUnits: entry.rule.minMarginUsdUnits,
    };
  }
  if (retail && own.priceUsdUnits > retail.priceUsdUnits) {
    return {
      priceUsdUnits: retail.priceUsdUnits,
      source: 'retail_cap',
      minMarginUsdUnits: retail.minMarginUsdUnits,
    };
  }
  return own;
}
