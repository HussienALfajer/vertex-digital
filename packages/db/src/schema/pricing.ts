import { MARGIN_SCOPES } from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { amountUnits, archivedAt, id, timestamps } from './columns.js';

/*
 * Margin rules (S06, F10; ADR 0020), owned by the api `pricing` module. `target_id` names a
 * category, game or product of the `catalog` module without a foreign key: the API checks it when
 * a rule is set. One live rule per target, and one global rule (seeded by 0025).
 */

export const marginScopeEnum = pgEnum('margin_scope', MARGIN_SCOPES);

export const marginRules = pgTable(
  'margin_rules',
  {
    id: id(),
    scope: marginScopeEnum('scope').notNull(),
    targetId: uuid('target_id'),
    percentBp: integer('percent_bp').notNull(),
    fixedUsdUnits: amountUnits('fixed_usd_units').notNull(),
    minMarginUsdUnits: amountUnits('min_margin_usd_units').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('margin_rules_scope_target_id_live_idx')
      .on(table.scope, table.targetId)
      .where(isNull(table.archivedAt)),
    /** The global rule's `target_id` is null, which the index above treats as distinct. */
    uniqueIndex('margin_rules_global_live_idx')
      .using('btree', sql`(true)`)
      .where(sql`${table.scope} = 'global' and ${table.archivedAt} is null`),
    index('margin_rules_target_id_idx').on(table.targetId),
    check(
      'margin_rules_target_check',
      sql`(${table.scope} = 'global') = (${table.targetId} is null)`,
    ),
    check('margin_rules_percent_bp_check', sql`${table.percentBp} between 0 and 10000`),
    check(
      'margin_rules_fixed_check',
      sql`${table.fixedUsdUnits} between 0 and 50000000 and ${table.fixedUsdUnits} % 10000 = 0`,
    ),
    check(
      'margin_rules_min_margin_check',
      sql`${table.minMarginUsdUnits} between 10000 and 50000000 and ${table.minMarginUsdUnits} % 10000 = 0`,
    ),
  ],
);
