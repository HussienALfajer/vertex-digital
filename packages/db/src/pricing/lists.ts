import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import type { Database, Transaction } from '../client.js';
import { marginRules } from '../schema/index.js';

/*
 * S20 decision 2 (owner, 2026-10-20): the wholesale and cost lists' global rules. Not seeded by a
 * migration: the release before S20 reads every live rule and the newest price row of any list,
 * so these rules, and the list rows they bring, arrive only once that release can no longer come
 * back (`pricing:reprice-lists` after a healthy deploy, RP4; `db:seed-local`; the tests' setup).
 */
const ROOT_LIST_RULES = [
  {
    id: '01a15a8c-b312-75f3-92d2-6da2e25d2df8',
    priceListId: ROOT_PRICE_LIST_IDS.wholesale,
    percentBp: 500,
    fixedUsdUnits: 0,
    minMarginUsdUnits: 50_000,
  },
  {
    id: '01a15a8c-b312-75f3-92d2-72570354506e',
    priceListId: ROOT_PRICE_LIST_IDS.cost,
    percentBp: 100,
    fixedUsdUnits: 0,
    minMarginUsdUnits: 10_000,
  },
] as const;

/**
 * Adds the wholesale and cost global rules with their fixed ids; a list that already has a live
 * global rule keeps it. Idempotent. Returns how many it added.
 */
export async function seedRootListRules(db: Database | Transaction): Promise<number> {
  const added = await db
    .insert(marginRules)
    .values(ROOT_LIST_RULES.map((rule) => ({ ...rule, scope: 'global' as const, targetId: null })))
    .onConflictDoNothing()
    .returning({ id: marginRules.id });
  return added.length;
}
