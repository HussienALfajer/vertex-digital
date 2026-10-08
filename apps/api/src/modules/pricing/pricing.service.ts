import { Inject, Injectable } from '@nestjs/common';
import {
  type DecideReviews,
  type DecideReviewsResult,
  type ErrorResponse,
  type MarginRule,
  type MarginRuleValues,
  type MarginScope,
  marginBasisPoints,
  type PageQuery,
  type PriceChangeCause,
  type PriceReview,
  type PriceReviewListQuery,
  type PriceReviewPage,
  type PriceReviewStatus,
  type PricingPreview,
  type PricingPreviewRequest,
  type ProductPricePage,
  priceFromCost,
  resolveMarginRule,
  type SetMarginRule,
  savings,
  sypDisplayPrice,
} from '@vertex-digital/contracts';
import {
  appendProductPrice,
  type Database,
  lockProductsForPricing,
  marginRules,
  newId,
  priceReviewPage,
  priceReviews,
  priceReviewsById,
  productPricePage,
  productRoutingStates,
  type ReviewListRow,
  type ReviewRow,
  recordAudit,
  repriceProducts,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import {
  type Actor,
  CatalogItemsService,
  CatalogService,
  type PricingTarget,
} from '../catalog/index.js';
import { RatesService } from '../rates/index.js';

type RuleRow = typeof marginRules.$inferSelect;

const valuesOf = (row: MarginRuleValues): MarginRuleValues => ({
  percentBp: row.percentBp,
  fixedUsdUnits: row.fixedUsdUnits,
  minMarginUsdUnits: row.minMarginUsdUnits,
});

const sameValues = (a: MarginRuleValues, b: MarginRuleValues) =>
  a.percentBp === b.percentBp &&
  a.fixedUsdUnits === b.fixedUsdUnits &&
  a.minMarginUsdUnits === b.minMarginUsdUnits;

const notFound = (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`);

/** The advisory lock of one target's rule: parallel sets of it leave one live rule (PR9). */
const ruleLock = (scope: MarginScope, targetId: string | null) =>
  sql`select pg_advisory_xact_lock(hashtext(${`margin_rule:${scope}:${targetId}`}))`;

const REVIEW_REFUSALS = ['NOT_FOUND', 'REVIEW_CLOSED', 'REVIEW_STALE'] as const;

type ReviewRefusal = (typeof REVIEW_REFUSALS)[number];

const isReviewRefusal = (code: string): code is ReviewRefusal =>
  (REVIEW_REFUSALS as readonly string[]).includes(code);

/**
 * The pricing engine (S06, F10; ADR 0020): margin rules (PR1, PR2, PR9) and the preview (PR10)
 * computed with the contracts' math (PR3–PR8). The only writer of `margin_rules`. From S07 the
 * `suppliers` module calls it to compute and store prices.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly catalog: CatalogService,
    private readonly items: CatalogItemsService,
    private readonly rates: RatesService,
  ) {}

  /** `GET /api/admin/pricing/rules`: live rules with their target and the products they govern. */
  async rules(): Promise<MarginRule[]> {
    const rows = await this.liveRules();
    const [names, paths] = await Promise.all([
      this.catalog.pricingTargetNames(
        rows.flatMap((row) => (row.targetId === null ? [] : [row.targetId])),
      ),
      this.catalog.livePricingPaths(),
    ]);
    const governed = new Map<string, number>();
    for (const path of paths) {
      const rule = resolveMarginRule(rows, path);
      governed.set(rule.id, (governed.get(rule.id) ?? 0) + 1);
    }
    return rows.map((row) => {
      const target = row.targetId === null ? undefined : names.get(row.targetId);
      return {
        id: row.id,
        scope: row.scope,
        targetId: row.targetId,
        ...valuesOf(row),
        targetName: target?.nameAr ?? null,
        targetArchived: target?.archived ?? false,
        productCount: governed.get(row.id) ?? 0,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Rule PR9: the live rule of the target, created or replaced, with its audit entry, under a lock
   * per target so parallel sets leave one live rule. The target must exist and be live.
   */
  async setRule(adminId: string, input: SetMarginRule, meta: RequestMeta): Promise<MarginRule> {
    const id = await this.db.transaction((tx) => this.setRuleIn(tx, adminId, input, meta));
    const rule = (await this.rules()).find((candidate) => candidate.id === id);
    if (!rule) throw notFound('margin rule');
    return rule;
  }

  /**
   * `setRule` in the caller's transaction (S07: a review's margin); returns the rule's id. A
   * change reprices every product the target covers in the same transaction (S07 rule P5).
   */
  private async setRuleIn(
    tx: Transaction,
    adminId: string,
    input: SetMarginRule,
    meta: RequestMeta,
  ): Promise<string> {
    const targetId = input.targetId ?? null;
    if (input.scope !== 'global') {
      const target = await this.catalog.pricingTarget(input.scope, targetId as string);
      if (!target || target.archived) throw notFound('catalog target');
    }
    const after = valuesOf(input);
    await tx.execute(ruleLock(input.scope, targetId));
    const [current] = await tx
      .select()
      .from(marginRules)
      .where(
        and(
          eq(marginRules.scope, input.scope),
          targetId === null ? isNull(marginRules.targetId) : eq(marginRules.targetId, targetId),
          isNull(marginRules.archivedAt),
        ),
      )
      .for('update');
    if (current && sameValues(valuesOf(current), after)) return current.id;
    const ruleId = current?.id ?? newId();
    if (current) {
      await tx.update(marginRules).set(after).where(eq(marginRules.id, ruleId));
    } else {
      await tx.insert(marginRules).values({ id: ruleId, scope: input.scope, targetId, ...after });
    }
    await this.audit(tx, adminId, meta, ruleId, 'margin_rule.set', {
      scope: input.scope,
      targetId,
      before: current ? valuesOf(current) : null,
      after,
    });
    await this.repriceCovered(tx, input.scope, targetId);
    return ruleId;
  }

  /** Its target falls back to the parent rule; the global rule stays (rule PR2). */
  async archiveRule(adminId: string, id: string, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(marginRules)
        .where(and(eq(marginRules.id, id), isNull(marginRules.archivedAt)))
        .for('update');
      if (!row) throw notFound('margin rule');
      if (row.scope === 'global') {
        throw new CodedException(409, 'GLOBAL_RULE_REQUIRED', 'The global rule cannot be archived');
      }
      await tx.update(marginRules).set({ archivedAt: new Date() }).where(eq(marginRules.id, id));
      await this.audit(tx, adminId, meta, id, 'margin_rule.archived', {
        scope: row.scope,
        targetId: row.targetId,
        values: valuesOf(row),
      });
      await this.repriceCovered(tx, row.scope, row.targetId);
    });
  }

  /** Rule PR10: PR3–PR8 for a cost and the target's rule or draft values; writes nothing. */
  async preview(input: PricingPreviewRequest & { costUsdUnits: number }): Promise<PricingPreview> {
    const { scope } = input.target;
    let target: PricingTarget | null = null;
    if (scope !== 'global') {
      target = await this.catalog.pricingTarget(scope, input.target.targetId as string);
      if (!target) throw notFound('catalog target');
    }
    const found = input.values
      ? null
      : resolveMarginRule(await this.liveRules(), target?.path ?? {});
    const rule = input.values ?? valuesOf(found as RuleRow);
    const price = priceFromCost(input.costUsdUnits, rule);
    const rate = await this.rates.current();
    const official = target?.officialPriceUsdUnits ?? null;
    return {
      rule,
      ruleScope: found?.scope ?? null,
      ruleId: found?.id ?? null,
      costUsdUnits: input.costUsdUnits,
      priceUsdUnits: price,
      marginUsdUnits: price - input.costUsdUnits,
      marginBp: marginBasisPoints(price, input.costUsdUnits),
      priceSypUnits: rate ? sypDisplayPrice(price, rate.sypPerUsd, rate.displayStepSypUnits) : null,
      rate: rate?.sypPerUsd ?? null,
      officialPriceUsdUnits: official,
      savings: savings(price, official),
    };
  }

  // Stored prices and reviews (S07 rules P2–P5) -------------------------------------------------

  /** `GET /api/admin/catalog/products/:id/prices`: newest first. */
  async prices(productId: string, page: PageQuery): Promise<ProductPricePage> {
    const target = await this.catalog.pricingTarget('product', productId);
    if (!target) throw notFound('product');
    const { items, total } = await productPricePage(this.db, productId, page);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  /** `GET /api/admin/pricing/reviews`. */
  async reviews(query: PriceReviewListQuery): Promise<PriceReviewPage> {
    const { rows, total } = await priceReviewPage(this.db, query);
    return {
      items: await this.toReviews(rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Rule P4: each decision in its own transaction, so one refusal leaves the others decided. An
   * accept is refused with `REVIEW_STALE` when the price it would give is not the one shown.
   */
  async decide(actor: Actor, input: DecideReviews): Promise<DecideReviewsResult> {
    const results: DecideReviewsResult['results'] = [];
    for (const decision of input.decisions) {
      try {
        await this.db.transaction(async (tx) => {
          const review = await this.lockReview(tx, decision.reviewId);
          if (decision.action === 'pause') {
            await this.items.pauseProductIn(tx, actor, review.productId);
            await this.close(tx, actor, review, 'paused', review.priceBeforeUsdUnits);
          } else {
            await this.accept(tx, actor, review, {
              expectedPriceUsdUnits: decision.expectedPriceUsdUnits ?? review.proposedPriceUsdUnits,
              cause: 'review_accepted',
              status: 'accepted',
            });
          }
        });
        results.push({
          reviewId: decision.reviewId,
          result: decision.action === 'pause' ? 'paused' : 'accepted',
        });
      } catch (error) {
        if (!(error instanceof CodedException) || !isReviewRefusal(error.code)) throw error;
        const { details } = error.getResponse() as ErrorResponse;
        const proposed = (details as { proposedPriceUsdUnits?: number | null } | undefined)
          ?.proposedPriceUsdUnits;
        results.push({
          reviewId: decision.reviewId,
          result: 'refused',
          errorCode: error.code,
          ...(error.code === 'REVIEW_STALE' ? { proposedPriceUsdUnits: proposed ?? null } : {}),
        });
      }
    }
    return { results };
  }

  /**
   * Rule P4: a product margin rule (S06 PR9) and the review accepted at the price it gives, in
   * one transaction. The rule's lock first, as every rule change takes it before the products.
   */
  async adjustMargin(
    actor: Actor,
    reviewId: string,
    values: MarginRuleValues,
  ): Promise<PriceReview> {
    await this.db.transaction(async (tx) => {
      const [found] = await tx
        .select({ productId: priceReviews.productId })
        .from(priceReviews)
        .where(eq(priceReviews.id, reviewId));
      if (!found) throw notFound('review');
      await tx.execute(ruleLock('product', found.productId));
      const review = await this.lockReview(tx, reviewId);
      await this.setRuleIn(
        tx,
        actor.adminId,
        { scope: 'product', targetId: review.productId, ...values },
        actor.meta,
      );
      await this.accept(tx, actor, review, {
        expectedPriceUsdUnits: null,
        cause: 'margin_adjusted',
        status: 'margin_adjusted',
      });
    });
    const [row] = await priceReviewsById(this.db, [reviewId]);
    const [review] = await this.toReviews([row as ReviewListRow]);
    return review as PriceReview;
  }

  /**
   * The review, its product's game and the product locked in the order every change takes them
   * (game, product, then the review the repricing write path also updates); refused unless open.
   */
  private async lockReview(tx: Transaction, reviewId: string): Promise<ReviewRow> {
    const [found] = await tx
      .select({ productId: priceReviews.productId })
      .from(priceReviews)
      .where(eq(priceReviews.id, reviewId));
    if (!found) throw notFound('review');
    await this.items.lockProduct(tx, found.productId);
    await lockProductsForPricing(tx, [found.productId]);
    const [review] = await tx
      .select()
      .from(priceReviews)
      .where(eq(priceReviews.id, reviewId))
      .for('update');
    if (review?.status !== 'open') {
      throw new CodedException(409, 'REVIEW_CLOSED', 'The review was already decided');
    }
    return review;
  }

  /**
   * Applies the price the basis gives now (rule P1) and closes the review. With an expected price,
   * a different one is refused with `REVIEW_STALE` and the new figure; a target equal to the price
   * on the same route writes no price row (edge case 3).
   */
  private async accept(
    tx: Transaction,
    actor: Actor,
    review: ReviewRow,
    options: {
      expectedPriceUsdUnits: number | null;
      cause: Extract<PriceChangeCause, 'review_accepted' | 'margin_adjusted'>;
      status: Extract<PriceReviewStatus, 'accepted' | 'margin_adjusted'>;
    },
  ): Promise<void> {
    const state = (
      await productRoutingStates(tx, [review.productId], routingContext(this.env))
    ).get(review.productId);
    const target = state?.targetPriceUsdUnits ?? null;
    if (
      !state?.basis ||
      target === null ||
      (options.expectedPriceUsdUnits !== null && target !== options.expectedPriceUsdUnits)
    ) {
      throw new CodedException(409, 'REVIEW_STALE', 'The proposed price changed', {
        proposedPriceUsdUnits: target,
      });
    }
    const { current } = state;
    const unchanged = current?.priceUsdUnits === target && current.routeId === state.basis.id;
    if (!unchanged) await appendProductPrice(tx, state, options.cause, review.id);
    await this.close(tx, actor, review, options.status, target);
  }

  private async close(
    tx: Transaction,
    actor: Actor,
    review: ReviewRow,
    status: Exclude<PriceReviewStatus, 'open' | 'superseded'>,
    priceAfterUsdUnits: number,
  ): Promise<void> {
    await tx
      .update(priceReviews)
      .set({ status, decidedAt: new Date(), adminId: actor.adminId })
      .where(eq(priceReviews.id, review.id));
    const action = (
      {
        accepted: 'price_review.accepted',
        paused: 'price_review.paused',
        margin_adjusted: 'price_review.margin_adjusted',
      } as const
    )[status];
    await recordAudit(tx, {
      action,
      actorKind: 'admin',
      actorId: actor.adminId,
      channel: 'admin',
      entityType: 'price_review',
      entityId: review.id,
      ipAddress: actor.meta.ipAddress,
      userAgent: actor.meta.userAgent,
      details: {
        productId: review.productId,
        priceBeforeUsdUnits: review.priceBeforeUsdUnits,
        priceAfterUsdUnits,
      },
    });
  }

  private async toReviews(rows: ReviewListRow[]): Promise<PriceReview[]> {
    const states = await productRoutingStates(
      this.db,
      rows.map((row) => row.review.productId),
      routingContext(this.env),
    );
    return rows.map(({ review, ...names }) => ({
      id: review.id,
      productId: review.productId,
      productNameAr: names.productNameAr,
      gameId: names.gameId,
      gameNameAr: names.gameNameAr,
      supplierCode: names.supplierCode,
      supplierNameAr: names.supplierNameAr,
      routeId: review.routeId,
      costBeforeUsdUnits: review.costBeforeUsdUnits,
      costAfterUsdUnits: review.costAfterUsdUnits,
      changeBp: review.changeBp,
      priceBeforeUsdUnits: review.priceBeforeUsdUnits,
      proposedPriceUsdUnits: review.proposedPriceUsdUnits,
      heldMarginUsdUnits: review.priceBeforeUsdUnits - review.costAfterUsdUnits,
      proposedMarginUsdUnits: review.proposedPriceUsdUnits - review.costAfterUsdUnits,
      status: review.status,
      availability: states.get(review.productId)?.availability ?? 'hidden',
      decidedAt: review.decidedAt?.toISOString() ?? null,
      createdAt: review.createdAt.toISOString(),
    }));
  }

  /** Rule P5: the products a rule's target covers, repriced with cause `rule_change`. */
  private async repriceCovered(
    tx: Transaction,
    scope: MarginScope,
    targetId: string | null,
  ): Promise<void> {
    const key = { global: null, category: 'categoryId', game: 'gameId', product: 'productId' }[
      scope
    ] as 'categoryId' | 'gameId' | 'productId' | null;
    const productIds = (await this.catalog.livePricingPaths())
      .filter((path) => key === null || path[key] === targetId)
      .map((path) => path.productId);
    await repriceProducts(tx, {
      productIds,
      cause: 'rule_change',
      context: routingContext(this.env),
    });
  }

  private liveRules(): Promise<RuleRow[]> {
    return this.db
      .select()
      .from(marginRules)
      .where(isNull(marginRules.archivedAt))
      .orderBy(asc(marginRules.createdAt));
  }

  private audit<Action extends 'margin_rule.set' | 'margin_rule.archived'>(
    tx: Transaction,
    adminId: string,
    meta: RequestMeta,
    ruleId: string,
    action: Action,
    details: Parameters<typeof recordAudit<Action>>[1]['details'],
  ) {
    return recordAudit(tx, {
      action,
      actorKind: 'admin',
      actorId: adminId,
      channel: 'admin',
      entityType: 'margin_rule',
      entityId: ruleId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details,
    });
  }
}
