import {
  LEVEL_TIERS,
  type LevelTier,
  ROOT_PRICE_LIST_IDS,
  TIER_CATEGORY_STEPS,
  TIER_LIST_NAMES,
  TIER_NAMES_AR,
  TIER_RULE_DEFAULTS,
  TIER_THRESHOLD_DEFAULTS,
  type TierRuleValues,
} from '@vertex-digital/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/index.js';
import { repriceProducts, routedProducts } from '../pricing/reprice.js';
import type { RoutingContext } from '../pricing/routing.js';
import { catalogCategories, marginRules, merchantLevels, priceLists } from '../schema/index.js';
import { queueAllMerchantLevels } from './levels.js';
import { liveTierLevels } from './tiers.js';

/*
 * S23 PX1: the one-off tier setup (`merchants:setup-tiers`, `db:seed-local`). Renames the wholesale
 * list "البرونزية"; creates the three chained tier lists with their global and category rules
 * (PX3); creates the three levels at the starter thresholds on them. Anything that already exists
 * by name (a list) or by tier (a live level) is left as it is and reported, so a rule the admin
 * edited is never changed. Then every routed product is priced on every list and every merchant's
 * recomputation is queued. Idempotent.
 */

/** Products per repricing transaction, as `pricing:reprice-lists`. */
const BATCH = 100;

/** The writer of the levels and of the lists takes these locks, in this order. */
const LEVELS_LOCK = sql`select pg_advisory_xact_lock(hashtext('merchant-levels'))`;

export interface TierSetupReport {
  /** One English line per step: what was created, left as it was or skipped. */
  lines: string[];
  listRowsAppended: number;
  merchantsQueued: number;
}

/** PX1: runs the setup; `jobs` queues the merchants' recomputations. */
export async function setupMerchantTiers(
  db: Database,
  context: { jobs: JobSender; routing: RoutingContext },
): Promise<TierSetupReport> {
  const lines: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(LEVELS_LOCK);
    await renameWholesale(tx, lines);
    const slugs = await categoryIds(tx, lines);
    let parentListId: string = ROOT_PRICE_LIST_IDS.wholesale;
    const levels = await liveTierLevels(tx);
    for (const tier of LEVEL_TIERS) {
      const listId = await tierList(tx, tier, parentListId, slugs, lines);
      const level = levels.find((candidate) => candidate.tier === tier);
      if (level) {
        lines.push(`The ${tier} level exists: left as it is.`);
      } else {
        const id = newId();
        const values = {
          monthlyThresholdUsdUnits: TIER_THRESHOLD_DEFAULTS[tier],
          priceListId: listId,
        };
        await tx
          .insert(merchantLevels)
          .values({ id, tier, nameAr: TIER_NAMES_AR[tier], ...values });
        await audit(tx, {
          action: 'merchant_tier.level_changed',
          entityType: 'merchant_level',
          entityId: id,
          details: { tier, before: null, after: values },
        });
        lines.push(`Created the ${tier} level at ${values.monthlyThresholdUsdUnits / 1e6} USD.`);
      }
      parentListId = level?.priceListId ?? listId;
    }
  });
  let listRowsAppended = 0;
  const productIds = await db.transaction((tx) => routedProducts(tx));
  for (let start = 0; start < productIds.length; start += BATCH) {
    const result = await db.transaction((tx) =>
      repriceProducts(tx, {
        productIds: productIds.slice(start, start + BATCH),
        cause: 'list_change',
        context: context.routing,
      }),
    );
    listRowsAppended += result.listRowsAppended;
  }
  const merchantsQueued = await db.transaction((tx) =>
    queueAllMerchantLevels(tx, context.jobs, 'tiers_changed'),
  );
  return { lines, listRowsAppended, merchantsQueued };
}

async function renameWholesale(tx: Transaction, lines: string[]) {
  const [list] = await tx
    .select({ name: priceLists.name })
    .from(priceLists)
    .where(eq(priceLists.id, ROOT_PRICE_LIST_IDS.wholesale))
    .for('update');
  const name = TIER_LIST_NAMES.bronze;
  if (!list || list.name === name) {
    lines.push('The wholesale list is named for Bronze already.');
    return;
  }
  await tx.update(priceLists).set({ name }).where(eq(priceLists.id, ROOT_PRICE_LIST_IDS.wholesale));
  await audit(tx, {
    action: 'price_list.renamed',
    entityType: 'price_list',
    entityId: ROOT_PRICE_LIST_IDS.wholesale,
    details: { before: { name: list.name }, after: { name } },
  });
  lines.push(`Renamed the wholesale list from "${list.name}" to "${name}".`);
}

/** PX3: the categories that take a rule, by slug; a missing one is reported and skipped. */
async function categoryIds(tx: Transaction, lines: string[]): Promise<Map<string, string>> {
  const wanted = [...TIER_CATEGORY_STEPS.half, ...TIER_CATEGORY_STEPS.none];
  const rows = await tx
    .select({ id: catalogCategories.id, slug: catalogCategories.slug })
    .from(catalogCategories)
    .where(and(inArray(catalogCategories.slug, wanted), isNull(catalogCategories.archivedAt)));
  const found = new Map(rows.map((row) => [row.slug, row.id]));
  for (const slug of wanted) {
    if (!found.has(slug)) lines.push(`Warning: no live category "${slug}": its rules are skipped.`);
  }
  return found;
}

/** The tier's list by name, or created under `parentListId` with its rules (PX3). */
async function tierList(
  tx: Transaction,
  tier: LevelTier,
  parentListId: string,
  categories: Map<string, string>,
  lines: string[],
): Promise<string> {
  const name = TIER_LIST_NAMES[tier];
  const [existing] = await tx
    .select({ id: priceLists.id, parentListId: priceLists.parentListId })
    .from(priceLists)
    .where(and(sql`lower(${priceLists.name}) = lower(${name})`, isNull(priceLists.archivedAt)));
  if (existing) {
    lines.push(
      existing.parentListId === parentListId
        ? `The list "${name}" exists: left as it is.`
        : `Warning: the list "${name}" exists under another parent: left as it is.`,
    );
    return existing.id;
  }
  const id = newId();
  await tx.insert(priceLists).values({ id, kind: 'custom', name, parentListId });
  await audit(tx, {
    action: 'price_list.created',
    entityType: 'price_list',
    entityId: id,
    details: { kind: 'custom', name, parentListId },
  });
  await rule(tx, id, null, TIER_RULE_DEFAULTS.global[tier]);
  for (const step of ['half', 'none'] as const) {
    for (const slug of TIER_CATEGORY_STEPS[step]) {
      const categoryId = categories.get(slug);
      if (categoryId) await rule(tx, id, categoryId, TIER_RULE_DEFAULTS[step][tier]);
    }
  }
  lines.push(`Created the list "${name}" with its rules.`);
  return id;
}

async function rule(
  tx: Transaction,
  priceListId: string,
  categoryId: string | null,
  values: TierRuleValues,
) {
  const scope = categoryId === null ? ('global' as const) : ('category' as const);
  const id = newId();
  const after = {
    percentBp: values.percentBp,
    fixedUsdUnits: 0,
    minMarginUsdUnits: values.minMarginUsdUnits,
  };
  await tx.insert(marginRules).values({ id, priceListId, scope, targetId: categoryId, ...after });
  await audit(tx, {
    action: 'margin_rule.set',
    entityType: 'margin_rule',
    entityId: id,
    details: { priceListId, scope, targetId: categoryId, before: null, after },
  });
}

function audit(
  tx: Transaction,
  entry: Pick<Parameters<typeof recordAudit>[1], 'action' | 'entityType' | 'entityId' | 'details'>,
) {
  return recordAudit(tx, {
    ...entry,
    actorKind: 'system',
    actorId: null,
    channel: 'cli',
  } as Parameters<typeof recordAudit>[1]);
}
