import { Inject, Injectable } from '@nestjs/common';
import {
  type CreatePriceList,
  type FixedPrice,
  type ListPriceCell,
  listChain,
  marginBasisPoints,
  PRICE_LIST_MAX_DEPTH,
  PRICE_LISTS_MAX_CUSTOM,
  type PriceList,
  type PriceListDetail,
  type PriceMatrix,
  type PriceMatrixQuery,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import {
  accountsOnList,
  assignedAccountCounts,
  assignedAccounts,
  type Database,
  fixedPriceFallbacks,
  listFixedPrices,
  listIsPriced,
  listPricingFacts,
  marginRules,
  newId,
  type PriceRow,
  priceListFixedPrices,
  priceLists,
  priceMatrix,
  productRoutingStates,
  queueStoreRevalidate,
  recordAudit,
  releaseArchivedAccounts,
  repriceProducts,
  routedProducts,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import { JobsService } from '../../core/jobs/index.js';
import { type Actor, CatalogItemsService } from '../catalog/index.js';
import { PricingService } from './pricing.service.js';

type ListRow = typeof priceLists.$inferSelect;

const notFound = (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`);

/** The lists' advisory lock: a creation counts the custom lists and checks the name under it. */
const listsLock = sql`select pg_advisory_xact_lock(hashtext('price_lists'))`;

/** The first accounts a list page shows (`priceListDetailSchema`). */
const LIST_PAGE_ACCOUNTS = 100;

/**
 * Price lists (S20 F29, ADR 0035; LS1–LS6, RP3): the lists, their fixed prices, the list page and
 * the product × list matrix. Every change is re-authenticated (the controller), audited and
 * repriced in its transaction; only a retail fixed price refreshes the store (SF4: it shows
 * retail only). A list's rules are `PricingService`'s.
 */
@Injectable()
export class PriceListsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly items: CatalogItemsService,
    private readonly pricing: PricingService,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/admin/pricing/lists`: every list, roots first, with its counts. */
  async lists(): Promise<PriceList[]> {
    const [rows, accounts, rules, fixed, fallbacks, facts] = await Promise.all([
      this.db.select().from(priceLists).orderBy(asc(priceLists.createdAt), asc(priceLists.id)),
      assignedAccountCounts(this.db),
      this.countBy(marginRules, marginRules.priceListId, isNull(marginRules.archivedAt)),
      this.countBy(
        priceListFixedPrices,
        priceListFixedPrices.priceListId,
        isNull(priceListFixedPrices.archivedAt),
      ),
      this.fallbackCounts(),
      listPricingFacts(this.db, []),
    ]);
    const order = (row: ListRow) => ['retail', 'wholesale', 'cost', 'custom'].indexOf(row.kind);
    return [...rows]
      .sort((a, b) => order(a) - order(b))
      .map((row) => {
        const chain = listChain(rows, row.id);
        return {
          id: row.id,
          kind: row.kind,
          name: row.name,
          parentListId: row.parentListId,
          chain,
          accounts: accounts.get(row.id) ?? 0,
          rules: rules.get(row.id) ?? 0,
          fixedPrices: fixed.get(row.id) ?? 0,
          fallbackCells: fallbacks.get(row.id) ?? 0,
          ready: listIsPriced(facts, chain),
          archivedAt: row.archivedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        };
      });
  }

  /** `GET /api/admin/pricing/lists/:id`: the list page. */
  async detail(id: string): Promise<PriceListDetail> {
    const list = (await this.lists()).find((candidate) => candidate.id === id);
    if (!list) throw notFound('price list');
    const [chain, fixed, accounts] = await Promise.all([
      this.db
        .select({ id: priceLists.id, kind: priceLists.kind, name: priceLists.name })
        .from(priceLists)
        .where(inArray(priceLists.id, list.chain)),
      this.fixedPrices(id),
      assignedAccounts(this.db, id, LIST_PAGE_ACCOUNTS),
    ]);
    return {
      list,
      chain: list.chain.flatMap((listId) => chain.filter((row) => row.id === listId)),
      fixedPrices: fixed,
      accounts,
    };
  }

  /**
   * LS1–LS3, RP3: a custom list under an unarchived, priced parent, at most 20 unarchived and 5
   * deep, its name unique among unarchived lists; every routed product priced for it in the same
   * transaction (cause `list_change`).
   */
  async create(actor: Actor, input: CreatePriceList): Promise<PriceList> {
    const id = await this.db.transaction(async (tx) => {
      await tx.execute(listsLock);
      await this.pricing.lockLiveList(tx, input.parentListId);
      const facts = await listPricingFacts(tx, []);
      const parentChain = facts.lists.find((list) => list.id === input.parentListId)
        ?.chain as string[];
      if (!listIsPriced(facts, parentChain)) {
        throw new CodedException(409, 'PRICE_LIST_NOT_READY', 'The parent list is not priced yet');
      }
      if (parentChain.length >= PRICE_LIST_MAX_DEPTH) {
        throw new CodedException(400, 'VALIDATION_FAILED', 'The list would be too deep', {
          fields: { parentListId: `At most ${PRICE_LIST_MAX_DEPTH} lists in a chain` },
        });
      }
      const [custom] = await tx
        .select({ count: count() })
        .from(priceLists)
        .where(and(eq(priceLists.kind, 'custom'), isNull(priceLists.archivedAt)));
      if ((custom?.count ?? 0) >= PRICE_LISTS_MAX_CUSTOM) {
        throw new CodedException(409, 'PRICE_LISTS_LIMIT_REACHED', 'Too many custom lists');
      }
      const listId = newId();
      await this.named(() =>
        tx.insert(priceLists).values({
          id: listId,
          kind: 'custom',
          name: input.name,
          parentListId: input.parentListId,
        }),
      );
      await this.audit(tx, actor, listId, 'price_list.created', {
        kind: 'custom',
        name: input.name,
        parentListId: input.parentListId,
      });
      await repriceProducts(tx, {
        productIds: await routedProducts(tx),
        cause: 'list_change',
        context: routingContext(this.env),
      });
      return listId;
    });
    return this.listOf(id);
  }

  /** `PATCH /api/admin/pricing/lists/:id`: root lists too (LS1). */
  async rename(actor: Actor, id: string, name: string): Promise<PriceList> {
    await this.db.transaction(async (tx) => {
      const list = await this.lockForChange(tx, id);
      if (list.name === name) return;
      await this.named(() => tx.update(priceLists).set({ name }).where(eq(priceLists.id, id)));
      await this.audit(tx, actor, id, 'price_list.renamed', {
        before: { name: list.name },
        after: { name },
      });
    });
    return this.listOf(id);
  }

  /**
   * LS5: a custom list with no unarchived account and no unarchived child; its rules and fixed
   * prices archived with it, archived accounts returned to their default. Its price rows stay
   * (orders name them); no other list's price changes, since nothing reads it any more.
   */
  async archive(actor: Actor, id: string): Promise<PriceList> {
    await this.db.transaction(async (tx) => {
      const list = await this.lockForChange(tx, id);
      if (list.kind !== 'custom') {
        throw new CodedException(400, 'VALIDATION_FAILED', 'A root list is never archived', {
          fields: { id: 'A root list is never archived' },
        });
      }
      const [children] = await tx
        .select({ count: count() })
        .from(priceLists)
        .where(and(eq(priceLists.parentListId, id), isNull(priceLists.archivedAt)));
      const accounts = await accountsOnList(tx, id);
      if (accounts > 0 || (children?.count ?? 0) > 0) {
        throw new CodedException(409, 'PRICE_LIST_IN_USE', 'The list is in use', {
          accounts,
          children: children?.count ?? 0,
        });
      }
      await releaseArchivedAccounts(tx, {
        priceListId: id,
        reason: `أُرشفت قائمة الأسعار ${list.name}`,
        actor: { adminId: actor.adminId, ...actor.meta },
      });
      const now = new Date();
      const rules = await tx
        .update(marginRules)
        .set({ archivedAt: now })
        .where(and(eq(marginRules.priceListId, id), isNull(marginRules.archivedAt)))
        .returning({ id: marginRules.id });
      const fixed = await tx
        .update(priceListFixedPrices)
        .set({ archivedAt: now })
        .where(
          and(eq(priceListFixedPrices.priceListId, id), isNull(priceListFixedPrices.archivedAt)),
        )
        .returning({ id: priceListFixedPrices.id });
      await tx.update(priceLists).set({ archivedAt: now }).where(eq(priceLists.id, id));
      await this.audit(tx, actor, id, 'price_list.archived', {
        name: list.name,
        rulesArchived: rules.length,
        fixedPricesArchived: fixed.length,
      });
    });
    return this.listOf(id);
  }

  /**
   * LS2, LP1, RP3: the list's fixed price for an unarchived product, archived and inserted again
   * when it changes (a price row names the value it used), then the product repriced on every list
   * (cause `list_change`). Answers the fixed price with the list's resulting price.
   */
  async setFixedPrice(
    actor: Actor,
    priceListId: string,
    productId: string,
    priceUsdUnits: number,
  ): Promise<FixedPrice> {
    await this.db.transaction(async (tx) => {
      await this.pricing.lockLiveList(tx, priceListId);
      await this.lockLiveProduct(tx, productId);
      const current = await this.liveFixedPrice(tx, priceListId, productId);
      if (current?.priceUsdUnits === priceUsdUnits) return;
      if (current) {
        await tx
          .update(priceListFixedPrices)
          .set({ archivedAt: new Date() })
          .where(eq(priceListFixedPrices.id, current.id));
      }
      await tx
        .insert(priceListFixedPrices)
        .values({ id: newId(), priceListId, productId, priceUsdUnits });
      await this.audit(tx, actor, priceListId, 'price_list.fixed_price_set', {
        productId,
        beforeUsdUnits: current?.priceUsdUnits ?? null,
        afterUsdUnits: priceUsdUnits,
      });
      await this.repriceFixed(tx, priceListId, productId);
    });
    const fixed = (await this.fixedPrices(priceListId, productId))[0];
    if (!fixed) throw notFound('fixed price');
    return fixed;
  }

  /** `DELETE …/fixed-prices/:productId`: archives the live fixed price; the rules apply again. */
  async archiveFixedPrice(actor: Actor, priceListId: string, productId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.pricing.lockLiveList(tx, priceListId);
      await this.lockLiveProduct(tx, productId);
      const current = await this.liveFixedPrice(tx, priceListId, productId);
      if (!current) throw notFound('fixed price');
      await tx
        .update(priceListFixedPrices)
        .set({ archivedAt: new Date() })
        .where(eq(priceListFixedPrices.id, current.id));
      await this.audit(tx, actor, priceListId, 'price_list.fixed_price_archived', {
        productId,
        priceUsdUnits: current.priceUsdUnits,
      });
      await this.repriceFixed(tx, priceListId, productId);
    });
  }

  /** `GET /api/admin/pricing/matrix`. */
  matrix(query: PriceMatrixQuery): Promise<PriceMatrix> {
    return priceMatrix(this.db, query, routingContext(this.env));
  }

  // ---------------------------------------------------------------------------------------------

  private async listOf(id: string): Promise<PriceList> {
    const list = (await this.lists()).find((candidate) => candidate.id === id);
    if (!list) throw notFound('price list');
    return list;
  }

  /** The list `FOR NO KEY UPDATE` (LS5: assignments and children take it `FOR SHARE`), live. */
  private async lockForChange(tx: Transaction, id: string): Promise<ListRow> {
    const [list] = await tx
      .select()
      .from(priceLists)
      .where(eq(priceLists.id, id))
      .for('no key update');
    if (!list) throw notFound('price list');
    if (list.archivedAt !== null) {
      throw new CodedException(409, 'PRICE_LIST_ARCHIVED', 'The price list is archived');
    }
    return list;
  }

  /** The product's game and the product locked as every catalog change takes them; unarchived. */
  private async lockLiveProduct(tx: Transaction, productId: string): Promise<void> {
    const { row } = await this.items.lockProduct(tx, productId);
    if (row.archivedAt !== null) throw notFound('product');
  }

  private async liveFixedPrice(tx: Transaction, priceListId: string, productId: string) {
    const [row] = await tx
      .select()
      .from(priceListFixedPrices)
      .where(
        and(
          eq(priceListFixedPrices.priceListId, priceListId),
          eq(priceListFixedPrices.productId, productId),
          isNull(priceListFixedPrices.archivedAt),
        ),
      )
      .for('update');
    return row ?? null;
  }

  private async repriceFixed(tx: Transaction, priceListId: string, productId: string) {
    await repriceProducts(tx, {
      productIds: [productId],
      cause: 'list_change',
      context: routingContext(this.env),
    });
    if (priceListId === ROOT_PRICE_LIST_IDS.retail) await queueStoreRevalidate(tx, this.jobs);
  }

  /** The list's live fixed prices (one product's when given), with the list's current price. */
  private async fixedPrices(priceListId: string, productId?: string): Promise<FixedPrice[]> {
    const rows = await listFixedPrices(this.db, priceListId, productId);
    const states = await productRoutingStates(
      this.db,
      rows.map((row) => row.fixed.productId),
      routingContext(this.env),
      priceListId,
    );
    return rows.map(({ fixed, ...names }) => ({
      id: fixed.id,
      priceListId: fixed.priceListId,
      productId: fixed.productId,
      ...names,
      priceUsdUnits: fixed.priceUsdUnits,
      result: cellOf(states.get(fixed.productId)),
      createdAt: fixed.createdAt.toISOString(),
    }));
  }

  /** LP1's fallback cells per list (`fixedPriceFallbacks`). */
  private async fallbackCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const row of await fixedPriceFallbacks(this.db)) {
      counts.set(row.priceListId, (counts.get(row.priceListId) ?? 0) + 1);
    }
    return counts;
  }

  private async countBy(
    table: typeof marginRules | typeof priceListFixedPrices,
    column: typeof marginRules.priceListId | typeof priceListFixedPrices.priceListId,
    where: ReturnType<typeof isNull>,
  ): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ priceListId: column, count: count() })
      .from(table)
      .where(where)
      .groupBy(column);
    return new Map(rows.map((row) => [row.priceListId, row.count]));
  }

  /** A name taken by another unarchived list answers `PRICE_LIST_NAME_TAKEN`. */
  private async named(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      if (violatedConstraint(error) === 'price_lists_name_live_idx') {
        throw new CodedException(409, 'PRICE_LIST_NAME_TAKEN', 'Another list has this name');
      }
      throw error;
    }
  }

  private audit<
    Action extends
      | 'price_list.created'
      | 'price_list.renamed'
      | 'price_list.archived'
      | 'price_list.fixed_price_set'
      | 'price_list.fixed_price_archived',
  >(
    tx: Transaction,
    actor: Actor,
    priceListId: string,
    action: Action,
    details: Parameters<typeof recordAudit<Action>>[1]['details'],
  ) {
    return recordAudit(tx, {
      action,
      actorKind: 'admin',
      actorId: actor.adminId,
      channel: 'admin',
      entityType: 'price_list',
      entityId: priceListId,
      ipAddress: actor.meta.ipAddress,
      userAgent: actor.meta.userAgent,
      details,
    });
  }
}

/** A list's current price for a product over the basis cost now (or its own cost). */
function cellOf(
  state: { current: PriceRow | null; basis: { costUsdUnits: number | null } | null } | undefined,
): ListPriceCell {
  const current = state?.current ?? null;
  if (!current) return { priceUsdUnits: null, source: null, marginUsdUnits: null, marginBp: null };
  const cost = (state?.basis?.costUsdUnits as number | null) ?? current.costUsdUnits;
  return {
    priceUsdUnits: current.priceUsdUnits,
    source: current.source,
    marginUsdUnits: current.priceUsdUnits - cost,
    marginBp: marginBasisPoints(current.priceUsdUnits, cost),
  };
}
