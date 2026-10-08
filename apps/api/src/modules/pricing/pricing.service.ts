import { Inject, Injectable } from '@nestjs/common';
import {
  type MarginRule,
  type MarginRuleValues,
  marginBasisPoints,
  type PricingPreview,
  type PricingPreviewRequest,
  priceFromCost,
  resolveMarginRule,
  type SetMarginRule,
  savings,
  sypDisplayPrice,
} from '@vertex-digital/contracts';
import {
  type Database,
  marginRules,
  newId,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { CatalogService, type PricingTarget } from '../catalog/index.js';
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

/**
 * The pricing engine (S06, F10; ADR 0020): margin rules (PR1, PR2, PR9) and the preview (PR10)
 * computed with the contracts' math (PR3–PR8). The only writer of `margin_rules`. From S07 the
 * `suppliers` module calls it to compute and store prices.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly catalog: CatalogService,
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
    const targetId = input.targetId ?? null;
    if (input.scope !== 'global') {
      const target = await this.catalog.pricingTarget(input.scope, targetId as string);
      if (!target || target.archived) throw notFound('catalog target');
    }
    const after = valuesOf(input);
    const id = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`margin_rule:${input.scope}:${targetId}`}))`,
      );
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
      return ruleId;
    });
    const rule = (await this.rules()).find((candidate) => candidate.id === id);
    if (!rule) throw notFound('margin rule');
    return rule;
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
