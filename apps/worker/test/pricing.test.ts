import { randomBytes } from 'node:crypto';
import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import {
  catalogCategories,
  catalogGames,
  catalogProducts,
  createDatabase,
  marginRules,
  newId,
  priceListFixedPrices,
  priceLists,
  productPrices,
  productRoutes,
  supplierOffers,
  suppliers,
  type Transaction,
  telegramMessages,
} from '@vertex-digital/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { FallbackNoticesJob } from '../src/jobs/pricing/fallback-notices.job.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * The fixed-price fallback notices (S20 RP5) against the test database, inside a rolled-back
 * transaction: the rows a repricing leaves are written directly, so the job's read is all that
 * runs.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const pgBoss = { boss: { send: async () => null } } as unknown as PgBossService;
const unique = () => randomBytes(4).toString('hex');

afterAll(() => connection.close());

async function isolated(work: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    db.transaction(async (tx) => {
      await work(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

/** A product with a custom list's fixed price whose newest list row has `source`. */
async function cell(tx: Transaction, source: 'fixed' | 'fixed_fallback') {
  const categoryId = newId();
  const gameId = newId();
  const productId = newId();
  const listId = newId();
  const fixedId = newId();
  const offerId = newId();
  const routeId = newId();
  await tx.insert(catalogCategories).values({
    id: categoryId,
    slug: `c-${unique()}`,
    nameAr: `فئة ${unique()}`,
    sortOrder: 99,
  });
  await tx.insert(catalogGames).values({
    id: gameId,
    categoryId,
    slug: `g-${unique()}`,
    nameAr: `ببجي ${unique()}`,
    nameEn: 'PUBG',
    sortOrder: 1,
  });
  await tx.insert(catalogProducts).values({
    id: productId,
    gameId,
    kind: 'direct',
    nameAr: '60 UC',
    maxQuantity: 1,
    sortOrder: 1,
  });
  await tx.insert(priceLists).values({
    id: listId,
    kind: 'custom',
    name: `VIP ${unique()}`,
    parentListId: ROOT_PRICE_LIST_IDS.wholesale,
  });
  await tx
    .insert(priceListFixedPrices)
    .values({ id: fixedId, priceListId: listId, productId, priceUsdUnits: usd(1.02) });
  const [fake] = await tx.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  await tx.insert(supplierOffers).values({
    id: offerId,
    supplierId: fake?.id as string,
    offerId: `o-${unique()}`,
    name: 'Offer',
    costUsdUnits: usd(1),
    inStock: true,
    lastSeenAt: new Date(),
  });
  await tx.insert(productRoutes).values({
    id: routeId,
    productId,
    supplierId: fake?.id as string,
    offerId,
    fieldMap: {},
  });
  const [rule] = await tx
    .select()
    .from(marginRules)
    .where(
      and(
        eq(marginRules.priceListId, ROOT_PRICE_LIST_IDS.wholesale),
        eq(marginRules.scope, 'global'),
        isNull(marginRules.archivedAt),
      ),
    );
  await tx.insert(productPrices).values({
    id: newId(),
    productId,
    priceListId: listId,
    source,
    fixedPriceId: fixedId,
    priceUsdUnits: source === 'fixed' ? usd(1.02) : usd(1.05),
    costUsdUnits: usd(1),
    routeId,
    ruleId: rule?.id as string,
    percentBp: 500,
    fixedUsdUnits: 0,
    minMarginUsdUnits: usd(0.05),
    cause: 'list_change',
  });
  return { listId, productId };
}

describe('pricing.fallback-notices (S20 RP5)', () => {
  it('tells each fallback once a Damascus day, never a fixed price that stands', () =>
    isolated(async (tx) => {
      const job = new FallbackNoticesJob(pgBoss, db);
      const fallback = await cell(tx, 'fixed_fallback');
      await cell(tx, 'fixed');
      const now = new Date('2030-03-01T10:00:00Z');
      // Rows other tests left may fall back too; ours is told once.
      await job.notify(tx, now);
      const told = async () =>
        tx
          .select()
          .from(telegramMessages)
          .where(
            eq(
              telegramMessages.dedupeKey,
              `fixed-fallback:${fallback.listId}:${fallback.productId}:2030-03-01`,
            ),
          );
      const [message] = await told();
      expect(message?.kind).toBe('fixed_price_fallback');
      expect(message?.params).toMatchObject({
        productId: fallback.productId,
        costUsdUnits: usd(1),
        fixedPriceUsdUnits: usd(1.02),
        priceUsdUnits: usd(1.05),
      });
      expect(await job.notify(tx, new Date('2030-03-01T20:00:00Z'))).toBe(0);
      expect(await told()).toHaveLength(1);
      // The next Damascus day tells it again while it lasts.
      expect(await job.notify(tx, new Date('2030-03-02T10:00:00Z'))).toBeGreaterThanOrEqual(1);
    }));

  it('renders the list, the pack, the cost and the price used', () => {
    const listId = newId();
    const { text } = renderTelegramMessage(
      'fixed_price_fallback',
      {
        priceListId: listId,
        priceListName: 'VIP',
        productId: newId(),
        productNameAr: '60 UC',
        gameNameAr: 'ببجي',
        costUsdUnits: usd(1),
        fixedPriceUsdUnits: usd(1.02),
        priceUsdUnits: usd(1.05),
      },
      { admin: 'http://127.0.0.1:5173' },
    );
    expect(text).toContain('السعر الثابت $1.02 في قائمة VIP');
    expect(text).toContain('ببجي · 60 UC: التكلفة $1.00، يُباع الآن بسعر القاعدة $1.05');
    expect(text).toContain(`http://127.0.0.1:5173/pricing/lists/${listId}`);
  });
});
