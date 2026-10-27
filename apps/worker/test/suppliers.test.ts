import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import {
  HEALTH_PROBE_REASON,
  priceFromCost,
  QUEUES,
  ROOT_PRICE_LIST_IDS,
  SUPPLIER_POLICY_DEFAULTS,
  TELEGRAM_MESSAGE_PARAMS,
  type TelegramMessageKind,
  type TelegramMessageParams,
} from '@vertex-digital/contracts';
import {
  type AppliedOutcome,
  type AttemptOutcome,
  catalogProducts,
  createDatabase,
  encryptCredentials,
  newId,
  priceReviews,
  productPrices,
  productRoutes,
  productRoutingStates,
  repriceProducts,
  type SupplierState,
  supplierBalanceReads,
  supplierCalls,
  supplierCategories,
  supplierCostChanges,
  supplierCredentials,
  supplierHealthChanges,
  supplierKey,
  supplierOffers,
  supplierPolicy,
  supplierStates,
  supplierSyncRuns,
  suppliers,
  type Transaction,
  telegramMessages,
} from '@vertex-digital/db';
import {
  FazercardsAdapter,
  type SupplierAccount,
  type SupplierAdapter,
  SupplierError,
  type SupplierMoney,
  type SupplierOffer,
  WdgzoneAdapter,
} from '@vertex-digital/suppliers';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  notInArray,
  notLike,
  sql,
} from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TelegramAlerts } from '../src/core/alerts/telegram-alerts.js';
import { parseEnv } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { markSubscriptionRefusal } from '../src/jobs/orders/order-calls.js';
import { SupplierBalancesJob } from '../src/jobs/suppliers/balances.job.js';
import { SupplierHealthJob } from '../src/jobs/suppliers/health.job.js';
import { listedOffers, SupplierSyncJob } from '../src/jobs/suppliers/sync.job.js';
import { SupplierSyncScheduleJob } from '../src/jobs/suppliers/sync-schedule.job.js';
import { DailySummaryJob } from '../src/jobs/telegram/daily-summary.job.js';
import { writeFakeSupplierState } from '../src/suppliers/fake-state-file.js';
import { recordedCall, sanitizedMessage } from '../src/suppliers/supplier-calls.js';
import { SupplierRegistry } from '../src/suppliers/supplier-registry.js';
import { renderTelegramMessage } from '../src/telegram/messages.js';

/*
 * The supplier jobs (S07 rules SY1–SY5, H1–H5) against the test database with scripted adapters.
 * The `fake` supplier's rows are shared with the api and db tests (which turbo runs before these),
 * so every test runs in a transaction that is rolled back, after moving the other tests' fake
 * offers and routes out of the way and putting the policy, health and balance at known values.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
const env = parseEnv();
const USD = 1_000_000;
const usd = (dollars: number) => Math.round(dollars * USD);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const run = randomBytes(4).toString('hex');
const unique = () => newId().replaceAll('-', '').slice(-12);
const offerKey = (name: string) => `w-${run}-${name}`;
const SECRET = `sk-${run}-do-not-leak-0123456789`;
const LINKS = { admin: 'http://127.0.0.1:5173' };

const ids = { fake: '', manual: '', wdgzone: '', fazercards: '' };

interface Sent {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}
const sent: Sent[] = [];
const pgBoss = {
  work: async () => {},
  boss: {
    send: async (
      queue: string,
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      sent.push({ queue, data, options });
      return newId();
    },
    schedule: async () => {},
  },
} as unknown as PgBossService;

/** The adapter the registry hands out now (each test scripts its own). */
let current: Partial<SupplierAdapter> = {};
const registry = {
  fakeEnabled: true,
  connect: async () => ({
    adapter: { capabilities: { balance: true, catalog: true }, ...current },
    secrets: [SECRET],
  }),
} as unknown as SupplierRegistry;

const sync = new SupplierSyncJob(pgBoss, registry, db, env);
// A new one per test: it remembers what it repriced (audit A05-17), which a rollback undoes.
let health = new SupplierHealthJob(pgBoss, registry, db, env);
const balances = new SupplierBalancesJob(pgBoss, registry, db, env);
const schedule = new SupplierSyncScheduleJob(pgBoss, db, env);

const offer = (
  name: string,
  dollars: number,
  extra: Partial<SupplierOffer> = {},
): SupplierOffer => ({
  offerId: offerKey(name),
  name: `Offer ${name}`,
  cost: { currency: 'USD', amountUnits: usd(dollars) },
  inStock: true,
  group: 'PUBG Mobile',
  kind: 'direct',
  requiredFields: ['playerId'],
  ...extra,
});

const listing = (...offers: SupplierOffer[]): Partial<SupplierAdapter> => ({
  listOffers: async () => offers,
});

const payload = (extra: { runId?: string; supplierId?: string } = {}) => ({
  supplierId: ids.fake,
  supplierCode: 'fake' as const,
  trigger: 'schedule' as const,
  ...extra,
});

/** S19: an adapter with the account reads (FazerCards'). */
const ACCOUNT_CAPABILITIES = {
  balance: true,
  catalog: true,
  categories: false,
  statement: false,
  platformStatus: false,
  validatePlayer: false,
  webhooks: false,
  offerQuote: false,
  offerWindow: false,
  account: true,
};

const fakeState = async (tx: Transaction) =>
  (await supplierStates(tx, { fakeEnabled: true })).find(
    (state) => state.id === ids.fake,
  ) as SupplierState;

beforeAll(async () => {
  const rows = await db.select({ id: suppliers.id, code: suppliers.code }).from(suppliers);
  for (const row of rows) {
    ids[row.code] = row.id;
  }
});

afterAll(async () => {
  await rm(env.FAKE_SUPPLIER_STATE_FILE, { force: true });
  await connection.close();
});

/**
 * Runs `work` in a transaction that is always rolled back. Inside it, the fake supplier has
 * credentials and no other offers or routes, the default policy, a `healthy` state, a large balance and a $50
 * threshold.
 */
async function isolated(work: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    db.transaction(async (tx) => {
      health = new SupplierHealthJob(pgBoss, registry, db, env);
      await prepare(tx);
      await work(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

/** The known starting point of every test, inside its transaction (offers of this run kept). */
async function prepare(tx: Transaction): Promise<void> {
  const mine = tx
    .select({ id: supplierOffers.id })
    .from(supplierOffers)
    .where(like(supplierOffers.offerId, `w-${run}-%`));
  await tx
    .update(productRoutes)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(productRoutes.supplierId, ids.fake),
        isNull(productRoutes.archivedAt),
        notInArray(productRoutes.offerId, mine),
      ),
    );
  await tx
    .update(supplierOffers)
    .set({ missingSince: new Date() })
    .where(
      and(
        eq(supplierOffers.supplierId, ids.fake),
        isNull(supplierOffers.missingSince),
        notLike(supplierOffers.offerId, `w-${run}-%`),
      ),
    );
  // Other runs' offers stay in the test database, and SY5's stale check reads every offer: one
  // crossing its stale limit during a test would count as newly stale and refresh the store
  // (S09 rule SF4). Long stale, they never do.
  await tx
    .update(supplierOffers)
    .set({ costConfirmedAt: new Date(0) })
    .where(notLike(supplierOffers.offerId, `w-${run}-%`));
  await tx.insert(supplierCredentials).values({
    id: newId(),
    supplierId: ids.fake,
    ciphertext: encryptCredentials(supplierKey(env.SUPPLIER_KEYS_SECRET), ids.fake, {
      webhookSecret: SECRET,
    }),
    hints: {},
    adminId: newId(),
  });
  await tx.insert(supplierPolicy).values({ id: newId(), ...SUPPLIER_POLICY_DEFAULTS });
  // An hour old, so a test can put a newer state in the past.
  await tx.insert(supplierHealthChanges).values({
    id: newId(),
    supplierId: ids.fake,
    state: 'healthy',
    reason: 'test start',
    createdAt: new Date(Date.now() - 3_600_000),
  });
  await tx.insert(supplierBalanceReads).values({
    id: newId(),
    supplierId: ids.fake,
    currency: 'USD',
    amountUnits: usd(1_000_000),
  });
  await tx
    .update(suppliers)
    .set({ lowBalanceUsdUnits: usd(50) })
    .where(eq(suppliers.id, ids.fake));
  sent.length = 0;
  current = {};
}

/** An active product in an active game with a `player_id` field and its own margin rule. */
async function product(tx: Transaction): Promise<string> {
  const [category, game, id] = [newId(), newId(), newId()];
  await tx.execute(
    sql`insert into catalog_categories (id, slug, name_ar, sort_order)
      values (${category}, ${`c-${unique()}`}, ${`فئة ${unique()}`}, 99)`,
  );
  await tx.execute(
    sql`insert into catalog_games (id, category_id, slug, name_ar, name_en, status, sort_order)
      values (${game}, ${category}, ${`g-${unique()}`}, ${`لعبة ${unique()}`}, 'Game', 'active', 1)`,
  );
  await tx.execute(
    sql`insert into catalog_input_fields (id, game_id, key, label_ar, type, required, sort_order)
      values (${newId()}, ${game}, 'player_id', 'المعرف', 'digits', true, 1)`,
  );
  await tx.execute(
    sql`insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
      values (${id}, ${game}, 'direct', ${`باقة ${unique()}`}, 1, 1)`,
  );
  await tx.execute(
    sql`insert into margin_rules (id, price_list_id, scope, target_id, percent_bp,
      fixed_usd_units, min_margin_usd_units) values (${newId()}, ${ROOT_PRICE_LIST_IDS.retail}, 'product', ${id}, ${RULE.percentBp},
      ${RULE.fixedUsdUnits}, ${RULE.minMarginUsdUnits})`,
  );
  return id;
}

const offerRow = async (tx: Transaction, name: string) => {
  const [row] = await tx
    .select()
    .from(supplierOffers)
    .where(
      and(eq(supplierOffers.supplierId, ids.fake), eq(supplierOffers.offerId, offerKey(name))),
    );
  return row as typeof supplierOffers.$inferSelect;
};

/** A route from the product to the offer, priced at once as the API does. */
async function route(tx: Transaction, productId: string, offerId: string, supplier = ids.fake) {
  const id = newId();
  await tx.insert(productRoutes).values({
    id,
    productId,
    supplierId: supplier,
    offerId,
    fieldMap: { playerId: 'player_id' },
  });
  await repriceProducts(tx, { productIds: [productId], cause: 'route_change', context: context() });
  return id;
}

/** A manual offer at `dollars` and its route (rule RT7). */
async function manualRoute(tx: Transaction, productId: string, dollars: number) {
  const offerId = newId();
  await tx.insert(supplierOffers).values({
    id: offerId,
    supplierId: ids.manual,
    offerId: newId(),
    name: 'Manual',
    kind: 'direct',
    requiredFields: [],
    costUsdUnits: usd(dollars),
    inStock: true,
    costConfirmedAt: new Date(),
    lastSeenAt: new Date(),
  });
  return route(tx, productId, offerId, ids.manual);
}

const context = () => ({ now: new Date(), fakeEnabled: true });

const routing = async (tx: Transaction, productId: string) =>
  (await productRoutingStates(tx, [productId], context())).get(productId);

const latestPrice = async (tx: Transaction, productId: string) =>
  (
    await tx
      .select()
      .from(productPrices)
      .where(
        and(
          eq(productPrices.productId, productId),
          eq(productPrices.priceListId, ROOT_PRICE_LIST_IDS.retail),
        ),
      )
      .orderBy(desc(productPrices.createdAt), desc(productPrices.id))
      .limit(1)
  )[0];

/** The messages of a kind written in this test's transaction (none of these kinds is committed). */
const messages = (tx: Transaction, kind: TelegramMessageKind) =>
  tx
    .select()
    .from(telegramMessages)
    .where(and(eq(telegramMessages.kind, kind), sql`${telegramMessages.createdAt} = now()`))
    .orderBy(asc(telegramMessages.id));

const message = async (tx: Transaction, dedupeKey: string) =>
  (await tx.select().from(telegramMessages).where(eq(telegramMessages.dedupeKey, dedupeKey)))[0];

async function failedRun(tx: Transaction, startedAt: Date) {
  const [row] = await tx
    .insert(supplierSyncRuns)
    .values({
      id: newId(),
      supplierId: ids.fake,
      trigger: 'schedule',
      status: 'failed',
      startedAt,
      finishedAt: startedAt,
      errorCode: 'SUPPLIER_ERROR',
    })
    .returning();
  return row as typeof supplierSyncRuns.$inferSelect;
}

describe('suppliers.sync (rules SY1–SY4)', () => {
  it('mirrors the catalog and reprices the products of changed offers (P2, P3)', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(
        offer('a', 0.88),
        {
          ...offer('b', 1),
          name: '  Offer b  ',
          cost: { currency: 'SYP', amountUnits: 1_500_000 },
        },
        { ...offer('c', 1), cost: { currency: 'USD', amountUnits: usd(10_001) }, group: '  ' },
        { ...offer('a', 5), name: 'A duplicate keeps the first' },
      );
      const first = await sync.sync(payload(), tx);
      expect(first).toMatchObject({
        status: 'succeeded',
        trigger: 'schedule',
        offersSeen: 3,
        offersNew: 3,
        costsChanged: 0,
        offersMissing: 0,
        errorCode: null,
      });
      const a = await offerRow(tx, 'a');
      expect(a).toMatchObject({
        name: 'Offer a',
        groupName: 'PUBG Mobile',
        kind: 'direct',
        requiredFields: ['playerId'],
        costUsdUnits: usd(0.88),
        costRaw: null,
        inStock: true,
        missingSince: null,
      });
      expect(a.costConfirmedAt).toEqual(first?.startedAt);
      // Another currency and a cost above $10,000 are kept raw, with no usable cost (edge case 6).
      expect(await offerRow(tx, 'b')).toMatchObject({
        name: 'Offer b',
        costUsdUnits: null,
        costRaw: expect.stringContaining('15,000'),
        costConfirmedAt: null,
      });
      expect(await offerRow(tx, 'c')).toMatchObject({
        groupName: null,
        costUsdUnits: null,
        costRaw: '$10,001.00',
      });

      await route(tx, p, a.id);
      expect(await latestPrice(tx, p)).toMatchObject({
        priceUsdUnits: priceFromCost(usd(0.88), RULE),
      });

      // Under 10%: the price follows at once.
      current = listing(offer('a', 0.92), offer('b', 1), offer('c', 2));
      const second = await sync.sync(payload(), tx);
      expect(second).toMatchObject({
        status: 'succeeded',
        offersNew: 0,
        costsChanged: 3,
        productsRepriced: 1,
        reviewsOpened: 0,
      });
      expect(await latestPrice(tx, p)).toMatchObject({
        priceUsdUnits: priceFromCost(usd(0.92), RULE),
        costUsdUnits: usd(0.92),
        cause: 'cost_sync',
      });
      const changes = await tx
        .select()
        .from(supplierCostChanges)
        .where(eq(supplierCostChanges.offerId, a.id));
      expect(changes).toEqual([
        expect.objectContaining({
          fromUsdUnits: usd(0.88),
          toUsdUnits: usd(0.92),
          syncRunId: second?.id,
          adminId: null,
        }),
      ]);
      expect(await message(tx, `sync:${second?.id}`)).toBeUndefined();

      // Over 10%: held for review; the held price is below the margin, so the guard pauses it.
      current = listing(offer('a', 1.1), offer('b', 1), offer('c', 2));
      const third = await sync.sync(payload(), tx);
      expect(third).toMatchObject({ costsChanged: 1, reviewsOpened: 1, productsRepriced: 0 });
      expect(await latestPrice(tx, p)).toMatchObject({ costUsdUnits: usd(0.92) });
      const [review] = await tx
        .select()
        .from(priceReviews)
        .where(and(eq(priceReviews.productId, p), eq(priceReviews.status, 'open')));
      expect(review).toMatchObject({
        costBeforeUsdUnits: usd(0.92),
        costAfterUsdUnits: usd(1.1),
        proposedPriceUsdUnits: priceFromCost(usd(1.1), RULE),
      });
      expect((await routing(tx, p))?.availability).toBe('paused_by_margin_guard');
      const summary = await message(tx, `sync:${third?.id}`);
      expect(summary).toMatchObject({ kind: 'supplier_sync_summary' });
      expect(summary?.params).toEqual({
        supplier: 'fake',
        supplierNameAr: 'مورد تجريبي',
        runId: third?.id,
        reviewsOpened: 1,
        marginGuarded: 1,
        mappedMissing: 0,
      });
      expect(sent.some((job) => job.queue === QUEUES.telegramSend)).toBe(true);
      // S09 rule SF4: each successful sync refreshes the store's catalog pages.
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
    }));

  it('writes a catalog larger than one batch completely (WDG lists 11,000+ offers)', () =>
    isolated(async (tx) => {
      const many = (cost: (i: number) => number) =>
        Array.from({ length: 1_201 }, (_, i) =>
          offer(`n${i}`, cost(i), {
            stock: i,
            fieldSpecs: i === 0 ? [] : undefined,
            unsupportedReason: i === 1 ? 'fields_unsupported' : undefined,
          }),
        );
      current = listing(...many(() => 1));
      expect(await sync.sync(payload(), tx)).toMatchObject({ offersSeen: 1_201, offersNew: 1_201 });
      current = listing(...many((i) => (i % 2 === 0 ? 2 : 1)));
      const second = await sync.sync(payload(), tx);
      expect(second).toMatchObject({ offersSeen: 1_201, offersNew: 0, costsChanged: 601 });
      const rows = await tx
        .select()
        .from(supplierOffers)
        .where(like(supplierOffers.offerId, `w-${run}-n%`));
      expect(rows).toHaveLength(1_201);
      for (const row of rows) {
        const i = Number(row.offerId.split('-n')[1]);
        expect(row).toMatchObject({
          costUsdUnits: usd(i % 2 === 0 ? 2 : 1),
          stock: i,
          requiredFields: ['playerId'],
          kind: 'direct',
          fieldSpecs: i === 0 ? [] : null,
          unsupportedReason: i === 1 ? 'fields_unsupported' : null,
          lastSeenAt: second?.startedAt,
          costConfirmedAt: second?.startedAt,
        });
      }
      const changes = await tx
        .select()
        .from(supplierCostChanges)
        .where(eq(supplierCostChanges.syncRunId, second?.id ?? ''));
      expect(changes).toHaveLength(601);
    }));

  it('refuses a suspicious catalog and changes nothing (SY3), and marks missing offers', () =>
    isolated(async (tx) => {
      const [p1, p2, p3] = [await product(tx), await product(tx), await product(tx)];
      current = listing(offer('a', 1), offer('b', 1), offer('c', 1), offer('d', 1));
      await sync.sync(payload(), tx);
      await route(tx, p1, (await offerRow(tx, 'a')).id);
      await route(tx, p2, (await offerRow(tx, 'b')).id);
      await route(tx, p3, (await offerRow(tx, 'c')).id);

      current = listing();
      expect(await sync.sync(payload(), tx)).toMatchObject({
        status: 'failed',
        errorCode: 'CATALOG_SUSPICIOUS',
        errorMessage: 'The supplier listed no offers',
      });
      // Two of three mapped offers would vanish at once: more than half.
      current = listing(offer('a', 2), offer('e', 1));
      expect(await sync.sync(payload(), tx)).toMatchObject({
        status: 'failed',
        errorCode: 'CATALOG_SUSPICIOUS',
        errorMessage: '2 of 3 mapped offers would go missing',
      });
      expect(await offerRow(tx, 'e')).toBeUndefined();
      expect(await offerRow(tx, 'a')).toMatchObject({ costUsdUnits: usd(1), missingSince: null });

      // One of three (and an unmapped one) may go: the product becomes unavailable (edge case 5).
      current = listing(offer('a', 1), offer('b', 1));
      const ran = await sync.sync(payload(), tx);
      expect(ran).toMatchObject({ status: 'succeeded', offersMissing: 2, costsChanged: 0 });
      expect((await offerRow(tx, 'c')).missingSince).toEqual(ran?.startedAt);
      const state = await routing(tx, p3);
      expect(state?.availability).toBe('out_of_stock');
      expect(state?.routes[0]?.unusableReason).toBe('offer_missing');
      expect((await message(tx, `sync:${ran?.id}`))?.params).toMatchObject({ mappedMissing: 1 });

      // Listed again: no longer missing, usable at once.
      current = listing(offer('a', 1), offer('b', 1), offer('c', 1));
      await sync.sync(payload(), tx);
      expect((await offerRow(tx, 'c')).missingSince).toBeNull();
      expect((await routing(tx, p3))?.availability).toBe('available');
    }));

  it('records a failed call, keeps credentials out of every message, alerts after 3 failures', () =>
    isolated(async (tx) => {
      const output: string[] = [];
      const capture = (...args: unknown[]) => {
        output.push(args.map(String).join(' '));
        return true;
      };
      const spies = [
        vi.spyOn(process.stdout, 'write').mockImplementation(capture),
        vi.spyOn(process.stderr, 'write').mockImplementation(capture),
        ...(['log', 'warn', 'error', 'debug'] as const).map((level) =>
          vi.spyOn(Logger.prototype, level).mockImplementation(capture),
        ),
      ];
      try {
        current = listing(offer('a', 1));
        expect(await sync.sync(payload(), tx)).toMatchObject({ status: 'succeeded' });
        const since = new Date();
        current = {
          listOffers: async () => {
            throw new SupplierError(
              'retryable',
              `GET https://api.example.com/v1/offers?key=${SECRET} timed out (${SECRET})`,
              { supplierCode: 'E_TIMEOUT' },
            );
          },
        };
        const failed = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          failed.push(await sync.sync(payload(), tx));
        }
        expect(failed[0]).toMatchObject({
          status: 'failed',
          errorCode: 'E_TIMEOUT',
          errorMessage: 'GET https://api.example.com/v1/offers timed out (***)',
        });
        const calls = await tx
          .select()
          .from(supplierCalls)
          .where(and(eq(supplierCalls.supplierId, ids.fake), gte(supplierCalls.createdAt, since)));
        expect(calls).toHaveLength(4);
        expect(
          calls.every((call) => call.result === 'error' && call.supplierCode === 'E_TIMEOUT'),
        ).toBe(true);
        const alerts = await messages(tx, 'supplier_sync_failing');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.dedupeKey).toBe(`sync-failing:fake:${failed[0]?.id}`);
        expect(alerts[0]?.params).toMatchObject({ reason: 'runs_failed', failedRuns: 3 });

        // A definitive refusal is `refused`, its code kept.
        current = {
          listOffers: async () => {
            throw new SupplierError('definitive', 'Bad key', { supplierCode: 'AUTH' });
          },
        };
        expect(await sync.sync(payload(), tx)).toMatchObject({ errorCode: 'AUTH' });

        // An adapter's plain error is the supplier's; a fault of ours closes the run as
        // `INTERNAL`, then fails the job, both without the secret.
        current = {
          listOffers: async () => {
            throw new Error(`socket closed for ${SECRET}`);
          },
        };
        expect(await sync.sync(payload(), tx)).toMatchObject({
          errorCode: 'SUPPLIER_ERROR',
          errorMessage: 'socket closed for ***',
        });
        current = listing({
          ...offer('a', 1),
          get offerId(): string {
            throw new Error(`unreadable offer for ${SECRET}`);
          },
        });
        await expect(sync.sync(payload(), tx)).rejects.toThrow(/unreadable offer for \*\*\*/);
        const [internal] = await tx
          .select()
          .from(supplierSyncRuns)
          .where(eq(supplierSyncRuns.supplierId, ids.fake))
          .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
          .limit(1);
        expect(internal).toMatchObject({ status: 'failed', errorCode: 'INTERNAL' });

        // Audit A05-13: told again once the streak has lasted 6 hours, once each 6 hours.
        current = {
          listOffers: async () => {
            throw new SupplierError('retryable', 'timed out', { supplierCode: 'E_TIMEOUT' });
          },
        };
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(Date.now() + 7 * 3_600_000);
          await sync.sync(payload(), tx);
          await sync.sync(payload(), tx);
        } finally {
          vi.useRealTimers();
        }
        const reminded = await messages(tx, 'supplier_sync_failing');
        expect(reminded.map((alert) => alert.dedupeKey)).toEqual([
          `sync-failing:fake:${failed[0]?.id}`,
          `sync-failing:fake:${failed[0]?.id}:1`,
        ]);

        const runs = await tx
          .select({ message: supplierSyncRuns.errorMessage })
          .from(supplierSyncRuns)
          .where(eq(supplierSyncRuns.supplierId, ids.fake));
        const stored = JSON.stringify({ runs, alerts, sent });
        expect(stored).not.toContain(SECRET);
        expect(output.join('\n')).not.toContain(SECRET);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }));

  it('runs one sync at a time, closes abandoned runs, follows the panel run (SY1)', () =>
    isolated(async (tx) => {
      current = listing(offer('a', 1));
      const [running] = await tx
        .insert(supplierSyncRuns)
        .values({ id: newId(), supplierId: ids.fake, trigger: 'admin' })
        .returning();
      // Another run is running: this job ends without a row.
      expect(await sync.sync(payload(), tx)).toBeNull();
      const open = await tx
        .select()
        .from(supplierSyncRuns)
        .where(
          and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')),
        );
      expect(open.map((row) => row.id)).toEqual([running?.id]);
      // The panel's run is the one the job runs, once.
      expect(await sync.sync(payload({ runId: running?.id }), tx)).toMatchObject({
        id: running?.id,
        status: 'succeeded',
        trigger: 'admin',
      });
      expect(await sync.sync(payload({ runId: running?.id }), tx)).toBeNull();

      // Audit A05-16: a run reading for 16 minutes (WDG's longest is 15) is still running.
      const [slow] = await tx
        .insert(supplierSyncRuns)
        .values({
          id: newId(),
          supplierId: ids.fake,
          trigger: 'schedule',
          startedAt: new Date(Date.now() - 16 * 60_000),
        })
        .returning();
      expect(await sync.sync(payload(), tx)).toBeNull();
      await tx
        .update(supplierSyncRuns)
        .set({ status: 'succeeded', finishedAt: new Date() })
        .where(eq(supplierSyncRuns.id, slow?.id as string));
      const [lost] = await tx
        .insert(supplierSyncRuns)
        .values({
          id: newId(),
          supplierId: ids.fake,
          trigger: 'schedule',
          startedAt: new Date(Date.now() - 31 * 60_000),
        })
        .returning();
      expect(await sync.sync(payload(), tx)).toMatchObject({ status: 'succeeded' });
      const [closed] = await tx
        .select()
        .from(supplierSyncRuns)
        .where(eq(supplierSyncRuns.id, lost?.id as string));
      expect(closed).toMatchObject({ status: 'failed', errorCode: 'ABANDONED' });
    }));

  it('catches up a price built on a cost the sync had already changed', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 0.88));
      await sync.sync(payload(), tx);
      const a = await offerRow(tx, 'a');
      await route(tx, p, a.id);
      // As if a sync committed $0.92 after the panel priced the route on $0.88.
      await tx
        .update(supplierOffers)
        .set({ costUsdUnits: usd(0.92) })
        .where(eq(supplierOffers.id, a.id));
      current = listing(offer('a', 0.92));
      expect(await sync.sync(payload(), tx)).toMatchObject({
        costsChanged: 0,
        productsRepriced: 1,
      });
      expect(await latestPrice(tx, p)).toMatchObject({
        costUsdUnits: usd(0.92),
        priceUsdUnits: priceFromCost(usd(0.92), RULE),
      });
    }));

  it('reprices when a select option the route sends leaves the offer, and when it comes back (F8-2)', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      const [game] = await tx
        .select({ gameId: catalogProducts.gameId })
        .from(catalogProducts)
        .where(eq(catalogProducts.id, p));
      await tx.execute(sql`insert into catalog_input_fields (id, game_id, key, label_ar, type,
        required, options, sort_order) values (${newId()}, ${game?.gameId}, 'region', 'المنطقة',
        'select', true, ${JSON.stringify([
          { value: 'asia', labelAr: 'آسيا' },
          { value: 'eu', labelAr: 'أوروبا' },
        ])}::jsonb, 2)`);
      const listed = (values: string[]) =>
        offer('select', 1, {
          requiredFields: ['playerId', 'region'],
          fieldSpecs: [
            { key: 'playerId', label: 'Player ID', type: 'text' },
            {
              key: 'region',
              label: 'Region',
              type: 'select',
              options: values.map((value) => ({ label: value, value })),
            },
          ],
        });
      current = listing(listed(['os_asia', 'os_euro', 'os_usa']));
      await sync.sync(payload(), tx);
      const a = await offerRow(tx, 'select');
      const fake = await route(tx, p, a.id);
      await tx
        .update(productRoutes)
        .set({
          fieldMap: { playerId: 'player_id', region: 'region' },
          optionMap: { region: { asia: 'os_asia', eu: 'os_euro' } },
        })
        .where(eq(productRoutes.id, fake));
      await manualRoute(tx, p, 2);
      expect(await latestPrice(tx, p)).toMatchObject({ routeId: fake, priceUsdUnits: usd(1.1) });

      // The supplier drops "os_euro" only: the route cannot send "eu", the manual one serves.
      current = listing(listed(['os_asia', 'os_usa']));
      await sync.sync(payload(), tx);
      expect((await routing(tx, p))?.basis?.supplierCode).toBe('manual');
      expect(await latestPrice(tx, p)).toMatchObject({
        priceUsdUnits: usd(2.2),
        cause: 'route_change',
      });

      // The option comes back: so does the route.
      current = listing(listed(['os_asia', 'os_euro', 'os_usa']));
      await sync.sync(payload(), tx);
      expect(await latestPrice(tx, p)).toMatchObject({ routeId: fake, priceUsdUnits: usd(1.1) });
    }));

  it("never stores or throws a failed query's parameters", () =>
    isolated(async (tx) => {
      const marker = `marker-${run}`;
      // PostgreSQL refuses a NUL in text: the insert of this offer fails as a query.
      current = listing({ ...offer('nul', 1), name: `${marker}\u0000` });
      const thrown = await sync.sync(payload(), tx).catch((error: Error) => error);
      expect(thrown).toBeInstanceOf(Error);
      const [internal] = await tx
        .select()
        .from(supplierSyncRuns)
        .where(eq(supplierSyncRuns.supplierId, ids.fake))
        .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
        .limit(1);
      expect(internal).toMatchObject({ status: 'failed', errorCode: 'INTERNAL' });
      for (const text of [internal?.errorMessage ?? '', (thrown as Error).message]) {
        expect(text).not.toContain('params');
        expect(text).not.toContain(marker);
      }
    }));

  it('lets the panel map an offer while a sync reprices the same game (no deadlock)', async () => {
    // Committed, so two transactions see them; archived and marked missing at the end.
    const [p1, p2] = await db.transaction(async (tx) => [await product(tx), await product(tx)]);
    const [x, y] = [newId(), newId()];
    await db.insert(supplierOffers).values(
      [x, y].map((id, index) => ({
        id,
        supplierId: ids.fake,
        offerId: offerKey(`par-${index}`),
        name: 'Parallel',
        kind: 'direct' as const,
        requiredFields: ['playerId'],
        costUsdUnits: usd(1),
        inStock: true,
        costConfirmedAt: new Date(),
        lastSeenAt: new Date(),
      })),
    );
    const routeX = newId();
    await db.insert(productRoutes).values({
      id: routeX,
      productId: p1,
      supplierId: ids.fake,
      offerId: x,
      fieldMap: { playerId: 'player_id' },
    });
    const [{ gameId } = { gameId: '' }] = (
      await db.execute(sql`select game_id as "gameId" from catalog_products where id = ${p1}`)
    ).rows as { gameId: string }[];
    const rollback = new Error('rollback');
    try {
      let releasePanel = () => {};
      const panelHolds = new Promise<void>((resolve) => {
        releasePanel = resolve;
      });
      let gameLocked = () => {};
      const locked = new Promise<void>((resolve) => {
        gameLocked = resolve;
      });
      // The panel: its game first, then a route insert (FOR KEY SHARE on the offer).
      const panel = db
        .transaction(async (tx) => {
          await tx.execute(sql`select id from catalog_games where id = ${gameId} for update`);
          gameLocked();
          await panelHolds;
          await tx.insert(productRoutes).values({
            id: newId(),
            productId: p2,
            supplierId: ids.fake,
            offerId: y,
            fieldMap: { playerId: 'player_id' },
          });
          throw rollback;
        })
        .catch((error: unknown) => error);
      await locked;
      let result: Awaited<ReturnType<SupplierSyncJob['sync']>> = null;
      const syncing = db
        .transaction(async (tx) => {
          await prepare(tx);
          current = listing(
            offer('par-0', 1.05, { name: 'Parallel' }),
            offer('par-1', 1, { name: 'Parallel' }),
          );
          result = await sync.sync(payload(), tx);
          throw rollback;
        })
        .catch((error: unknown) => error);
      // The sync waits on the game the panel holds; then the panel inserts its route.
      for (let tries = 0; tries < 100; tries += 1) {
        const { rows } = await db.execute(
          sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if ((rows[0] as { waiting: number }).waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releasePanel();
      expect(await panel).toBe(rollback);
      expect(await syncing).toBe(rollback);
      expect(result).toMatchObject({ status: 'succeeded', productsRepriced: 1 });
    } finally {
      await db
        .update(productRoutes)
        .set({ archivedAt: new Date() })
        .where(eq(productRoutes.id, routeX));
      await db
        .update(supplierOffers)
        .set({ missingSince: new Date() })
        .where(inArray(supplierOffers.id, [x, y]));
      await db.execute(
        sql`update catalog_categories set archived_at = now() where id in (select category_id
          from catalog_games where id = ${gameId})`,
      );
    }
  });

  it('fails a run of a supplier whose adapter cannot be built (edge case 14)', () =>
    isolated(async (tx) => {
      // WDGZone keys without its API key: the registry has no adapter for them.
      await tx.insert(supplierCredentials).values({
        id: newId(),
        supplierId: ids.wdgzone,
        ciphertext: encryptCredentials(supplierKey(env.SUPPLIER_KEYS_SECRET), ids.wdgzone, {}),
        hints: {},
        adminId: newId(),
      });
      const [run] = await tx
        .insert(supplierSyncRuns)
        .values({ id: newId(), supplierId: ids.wdgzone, trigger: 'admin' })
        .returning();
      // The real registry: the scripted one above hands an adapter to every supplier.
      const real = new SupplierSyncJob(pgBoss, new SupplierRegistry(env), db, env);
      expect(
        await real.sync(
          {
            supplierId: ids.wdgzone,
            supplierCode: 'wdgzone',
            trigger: 'admin',
            runId: run?.id,
          },
          tx,
        ),
      ).toMatchObject({ status: 'failed', errorCode: 'SUPPLIER_UNAVAILABLE' });
    }));

  it('keeps the order bounds of an offer only when both are whole, in range and in order (S19)', () => {
    const bounds = (minQuantity?: number, maxQuantity?: number) => {
      const [row] = listedOffers([{ ...offer('q', 1), minQuantity, maxQuantity }]);
      return [row?.minQuantity, row?.maxQuantity];
    };
    expect(bounds(1, 100)).toEqual([1, 100]);
    expect(bounds(1, undefined)).toEqual([null, null]);
    expect(bounds(5, 2)).toEqual([null, null]);
    expect(bounds(0, 2)).toEqual([null, null]);
    expect(bounds(1, 1.5)).toEqual([null, null]);
  });

  it('checks each offer on its own (SY2)', () => {
    expect(
      listedOffers([
        { ...offer('x', 1), offerId: '  ' },
        { ...offer('x', 1), offerId: 'x'.repeat(129) },
        { ...offer('y', 0), requiredFields: ['player id'] },
        { ...offer('z', 1), name: '', kind: 'bundle' as never, inStock: 'yes' as never },
      ]),
    ).toEqual([
      expect.objectContaining({
        offerId: offerKey('y'),
        costUsdUnits: null,
        costRaw: '$0.00',
        requiredFields: null,
      }),
      expect.objectContaining({
        offerId: offerKey('z'),
        name: offerKey('z'),
        kind: null,
        inStock: false,
      }),
    ]);
  });
});

describe('suppliers.sync: audit F9 regressions', () => {
  it('tests credentials replaced while a run read with the earlier ones (audit F9-6)', () =>
    isolated(async (tx) => {
      const syncs = () => sent.filter((job) => job.queue === QUEUES.suppliersSync);
      current = listing(offer('a', 1));
      await sync.sync(payload(), tx);
      expect(syncs()).toEqual([]);
      current = {
        listOffers: async () => {
          // The admin saves new keys while the run reads the catalog.
          await tx.insert(supplierCredentials).values({
            id: newId(),
            supplierId: ids.fake,
            ciphertext: encryptCredentials(supplierKey(env.SUPPLIER_KEYS_SECRET), ids.fake, {
              webhookSecret: `${SECRET}-new`,
            }),
            hints: {},
            adminId: newId(),
          });
          return [offer('a', 1)];
        },
      };
      await sync.sync(payload(), tx);
      expect(syncs().map((job) => job.data)).toEqual([
        { supplierId: ids.fake, supplierCode: 'fake', trigger: 'admin' },
      ]);
      // No retry, as the schedule's (audit A05-62).
      expect(syncs()[0]?.options).toMatchObject({ retryLimit: 0 });
    }));

  it('keeps a cost observed after the run began reading (audit A05-8)', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 0.88));
      await sync.sync(payload(), tx);
      const a = await offerRow(tx, 'a');
      await route(tx, p, a.id);
      current = {
        listOffers: async () => {
          // A charge of $0.95 is recorded (S18 CH3) while the run reads the listing's $0.88.
          await tx
            .update(supplierOffers)
            .set({ costUsdUnits: usd(0.95), costConfirmedAt: new Date() })
            .where(eq(supplierOffers.id, a.id));
          return [offer('a', 0.88)];
        },
      };
      expect(await sync.sync(payload(), tx)).toMatchObject({ costsChanged: 0 });
      expect(await offerRow(tx, 'a')).toMatchObject({ costUsdUnits: usd(0.95) });
      // A later run reads after it: the listing wins again (Q25 open).
      await tx
        .update(supplierOffers)
        .set({ costConfirmedAt: new Date(Date.now() - 60_000) })
        .where(eq(supplierOffers.id, a.id));
      current = listing(offer('a', 0.88));
      expect(await sync.sync(payload(), tx)).toMatchObject({ costsChanged: 1 });
    }));

  it('stops a route whose offer the supplier turned into another kind (audit F9-5)', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 1));
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'a')).id);
      expect((await routing(tx, p))?.availability).toBe('available');
      current = listing(offer('a', 1, { kind: 'code' }));
      await sync.sync(payload(), tx);
      const state = await routing(tx, p);
      expect(state?.routes[0]?.unusableReason).toBe('kind_mismatch');
      expect(state?.availability).toBe('out_of_stock');
      current = listing(offer('a', 1));
      await sync.sync(payload(), tx);
      expect((await routing(tx, p))?.availability).toBe('available');
    }));
});

describe('S18: the catalog version, discounts and why calls fail', () => {
  const CAPABILITIES = {
    balance: true,
    catalog: true,
    categories: false,
    statement: false,
    platformStatus: true,
    validatePlayer: false,
    webhooks: false,
    offerQuote: false,
    offerWindow: false,
    account: false,
  };
  const newestRun = async (tx: Transaction) =>
    (
      await tx
        .select()
        .from(supplierSyncRuns)
        .where(eq(supplierSyncRuns.supplierId, ids.fake))
        .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
        .limit(1)
    )[0];

  it('reads no offers while the catalog has not changed within the hour (SY4)', () =>
    isolated(async (tx) => {
      let reads = 0;
      let version = new Date('2026-10-19T17:19:06Z');
      current = {
        capabilities: CAPABILITIES,
        getPlatformStatus: async () => ({ status: 'operational', catalogUpdatedAt: version }),
        listOffers: async () => {
          reads += 1;
          return [offer('a', 1, { discountBp: 200 })];
        },
      };
      await sync.sync(payload(), tx);
      expect(await newestRun(tx)).toMatchObject({
        status: 'succeeded',
        offersRead: true,
        platformStatus: 'operational',
        catalogUpdatedAt: version,
      });
      // DC1: the discount is kept on the offer.
      expect((await offerRow(tx, 'a')).discountBp).toBe(200);
      await sync.sync(payload(), tx);
      expect(reads).toBe(1);
      expect(await newestRun(tx)).toMatchObject({ status: 'succeeded', offersRead: false });
      version = new Date('2026-10-19T17:34:06Z');
      await sync.sync(payload(), tx);
      expect(reads).toBe(2);
      expect(await newestRun(tx)).toMatchObject({ offersRead: true, catalogUpdatedAt: version });
    }));

  it('reads in full when the status cannot be read', () =>
    isolated(async (tx) => {
      let reads = 0;
      current = {
        capabilities: CAPABILITIES,
        getPlatformStatus: async () => {
          throw new SupplierError('retryable', 'Timed out', { failure: 'timeout' });
        },
        listOffers: async () => {
          reads += 1;
          return [offer('a', 1)];
        },
      };
      await sync.sync(payload(), tx);
      await sync.sync(payload(), tx);
      expect(reads).toBe(2);
      expect(await newestRun(tx)).toMatchObject({ offersRead: true, platformStatus: null });
    }));

  it('records why a call failed and the supplier code, never a message (FK1, HE6)', () =>
    isolated(async (tx) => {
      const newestCall = async () =>
        (
          await tx
            .select()
            .from(supplierCalls)
            .where(eq(supplierCalls.supplierId, ids.fake))
            .orderBy(desc(supplierCalls.createdAt), desc(supplierCalls.id))
            .limit(1)
        )[0];
      await recordedCall(tx, ids.fake, 'get_balance', async () => {
        throw new SupplierError('retryable', 'Supplier answered HTTP 503', {
          status: 503,
          failure: 'http_5xx',
        });
      });
      expect(await newestCall()).toMatchObject({
        result: 'error',
        failureKind: 'http_5xx',
        httpStatus: 503,
        supplierCode: null,
      });
      await recordedCall(tx, ids.fake, 'get_balance', async () => {
        throw new Error('a bug of ours');
      });
      expect(await newestCall()).toMatchObject({ result: 'error', failureKind: 'other' });
      await recordedCall(tx, ids.fake, 'place_order', async () => {
        throw new SupplierError('definitive', 'Refused', { status: 422, supplierCode: 'NO' });
      });
      expect(await newestCall()).toMatchObject({
        result: 'refused',
        failureKind: null,
        httpStatus: 422,
        supplierCode: 'NO',
      });
      // An order answer the supplier gave that does not settle it yet: no error (HE4).
      await recordedCall(
        tx,
        ids.fake,
        'get_order',
        async () => 'answer',
        () => ({ result: 'ok', supplierCode: 'ORDER_NOT_FOUND', httpStatus: 404 }),
      );
      expect(await newestCall()).toMatchObject({
        result: 'ok',
        failureKind: null,
        supplierCode: 'ORDER_NOT_FOUND',
        httpStatus: 404,
      });
      await recordedCall(
        tx,
        ids.fake,
        'get_order',
        async () => 'answer',
        () => ({ result: 'error', httpStatus: 42 }),
      );
      expect(await newestCall()).toMatchObject({ failureKind: 'other', httpStatus: null });
    }));
});

describe('suppliers.sync-schedule (rule SY1)', () => {
  it('queues a sync for each configured, available supplier with a catalog', () =>
    isolated(async (tx) => {
      // S19 FC2: FazerCards syncs once it has its credentials, like any supplier with a catalog.
      await tx.insert(supplierCredentials).values({
        id: newId(),
        supplierId: ids.fazercards,
        ciphertext: encryptCredentials(supplierKey(env.SUPPLIER_KEYS_SECRET), ids.fazercards, {
          apiKey: SECRET,
          webhookSecret: SECRET,
        }),
        hints: {},
        adminId: newId(),
      });
      const queued = await schedule.enqueue(tx);
      expect(queued.map((job) => job.supplierCode)).toEqual(['fazercards', 'fake']);
      expect(sent).toEqual([
        {
          queue: QUEUES.suppliersSync,
          data: { supplierId: ids.fazercards, supplierCode: 'fazercards', trigger: 'schedule' },
          options: { retryLimit: 0 },
        },
        {
          queue: QUEUES.suppliersSync,
          data: { supplierId: ids.fake, supplierCode: 'fake', trigger: 'schedule' },
          options: { retryLimit: 0 },
        },
      ]);
    }));

  it('skips a supplier whose plan is inactive until it comes back (audit A05-14)', () =>
    isolated(async (tx) => {
      const plan = (active: boolean) =>
        tx
          .update(suppliers)
          .set({ accountPlan: 'trial', accountActive: active, accountCheckedAt: new Date() })
          .where(eq(suppliers.id, ids.fake));
      await plan(false);
      expect((await schedule.enqueue(tx)).map((job) => job.supplierCode)).not.toContain('fake');
      await plan(true);
      expect((await schedule.enqueue(tx)).map((job) => job.supplierCode)).toContain('fake');
    }));

  it('counts a refusal for an inactive plan as an answer, not an error (audit A05-15)', () =>
    isolated(async (tx) => {
      const call = await recordedCall(tx, ids.fake, 'list_offers', async () => {
        throw new SupplierError('retryable', 'HTTP 403', {
          supplierCode: 'subscription_inactive',
          status: 403,
          failure: 'http_4xx',
        });
      });
      expect(call).toMatchObject({ ok: false, result: 'refused' });
    }));
});

describe('suppliers.health (rules H1–H4, SY5)', () => {
  const OPERATIONS = ['get_balance', 'list_offers', 'get_order'] as const;
  /** Calls of the balance read, the catalog and a poll in turn (S18 HE3 needs two or more). */
  const calls = (tx: Transaction, ...results: ('ok' | 'error')[]) =>
    tx.insert(supplierCalls).values(
      results.map((result, index) => ({
        id: newId(),
        supplierId: ids.fake,
        operation: OPERATIONS[index % OPERATIONS.length] as (typeof OPERATIONS)[number],
        result,
        latencyMs: 200,
      })),
    );
  const standing = async (tx: Transaction) =>
    (
      await tx
        .select()
        .from(supplierHealthChanges)
        .where(eq(supplierHealthChanges.supplierId, ids.fake))
        .orderBy(desc(supplierHealthChanges.createdAt), desc(supplierHealthChanges.id))
        .limit(1)
    )[0];

  it('goes down after consecutive errors, reprices, probes back, then turns healthy', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 0.88));
      await sync.sync(payload(), tx);
      const fakeRoute = await route(tx, p, (await offerRow(tx, 'a')).id);
      const manual = await manualRoute(tx, p, 1.2);
      expect(await latestPrice(tx, p)).toMatchObject({ routeId: fakeRoute });

      // S18 AL2: the admin was last told `healthy` (other runs' messages stay in the database).
      await tx.insert(telegramMessages).values({
        id: newId(),
        kind: 'supplier_health',
        params: {
          supplier: 'fake',
          supplierNameAr: 'مورد تجريبي',
          state: 'healthy',
          previous: 'degraded',
          successBp: null,
        },
      });
      await calls(tx, 'error', 'error', 'error');
      const checkedAt = new Date();
      sent.length = 0;
      await health.check(checkedAt, tx);
      const down = await standing(tx);
      // S09 rule SF4: the store shows each game's service status.
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
      // The rate over the window's calls: this test's sync call and three errors, and the calls
      // other test files committed within the health window (append-only, so they stay).
      const window = await tx
        .select({ result: supplierCalls.result })
        .from(supplierCalls)
        .where(
          and(
            eq(supplierCalls.supplierId, ids.fake),
            gte(
              supplierCalls.createdAt,
              new Date(checkedAt.getTime() - SUPPLIER_POLICY_DEFAULTS.healthWindowMinutes * 60_000),
            ),
          ),
        );
      const answered = window.filter((call) => call.result !== 'error').length;
      expect(down).toMatchObject({ state: 'down', reason: '3 consecutive errors' });
      expect(await latestPrice(tx, p)).toMatchObject({
        routeId: manual,
        priceUsdUnits: priceFromCost(usd(1.2), RULE),
        cause: 'route_change',
      });
      expect((await message(tx, `health:${down?.id}`))?.params).toEqual({
        supplier: 'fake',
        supplierNameAr: 'مورد تجريبي',
        state: 'down',
        previous: 'healthy',
        // Alone: the sync's catalog call answered and three errors followed, 2,500.
        successBp: Math.floor((answered * 10_000) / window.length),
      });
      // Safe twice: no change, no row.
      await health.check(new Date(), tx);
      expect((await standing(tx))?.id).toBe(down?.id);

      // Ten minutes later the probe succeeds: degraded.
      current = { getBalance: async () => ({ currency: 'USD', amountUnits: usd(500) }) };
      await health.check(new Date(Date.now() + 11 * 60_000), tx);
      expect(await standing(tx)).toMatchObject({ state: 'degraded', reason: HEALTH_PROBE_REASON });

      // Healthy only once the calls since the probe meet the rules with the minimum count, held
      // at each of the last 5 minutes (S18 HE2).
      await calls(tx, 'ok', 'ok', 'ok', 'ok');
      await health.check(new Date(), tx);
      expect((await standing(tx))?.state).toBe('degraded');
      await calls(tx, 'ok', 'ok', 'ok', 'ok', 'ok', 'ok');
      await health.check(new Date(), tx);
      expect((await standing(tx))?.state).toBe('degraded');
      await health.check(new Date(Date.now() + 6 * 60_000), tx);
      expect(await standing(tx)).toMatchObject({ state: 'healthy', reason: 'success 100%' });
      expect(await latestPrice(tx, p)).toMatchObject({ routeId: fakeRoute });
      const states = (await messages(tx, 'supplier_health')).map(
        (row) => (row.params as { state: string }).state,
      );
      // The baseline this test wrote, then one message per state that held.
      expect(states).toEqual(['healthy', 'down', 'degraded', 'healthy']);
    }));

  it('tells a degraded state only once it has held 5 minutes (S18 AL1, AL2)', () =>
    isolated(async (tx) => {
      // A probe's degraded: only calls since it count, too few to change the state.
      const [row] = await tx
        .insert(supplierHealthChanges)
        .values({
          id: newId(),
          supplierId: ids.fake,
          state: 'degraded',
          reason: HEALTH_PROBE_REASON,
          createdAt: new Date(Date.now() - 2 * 60_000),
        })
        .returning();
      await health.check(new Date(), tx);
      expect((await standing(tx))?.id).toBe(row?.id);
      expect(await message(tx, `health:${row?.id}`)).toBeUndefined();
      await health.check(new Date(Date.now() + 4 * 60_000), tx);
      expect((await message(tx, `health:${row?.id}`))?.params).toMatchObject({
        supplier: 'fake',
        state: 'degraded',
      });
      // Told once.
      await health.check(new Date(Date.now() + 5 * 60_000), tx);
      expect(
        (await messages(tx, 'supplier_health')).filter(
          (sentRow) => sentRow.dedupeKey === `health:${row?.id}`,
        ),
      ).toHaveLength(1);
    }));

  it('is not down from one operation erring three times (S18 HE3)', () =>
    isolated(async (tx) => {
      const before = await standing(tx);
      await tx.insert(supplierCalls).values(
        [1, 2, 3].map(() => ({
          id: newId(),
          supplierId: ids.fake,
          operation: 'get_order' as const,
          result: 'error' as const,
          latencyMs: 15_000,
          failureKind: 'timeout',
        })),
      );
      await health.check(new Date(), tx);
      const after = await standing(tx);
      expect(after?.state === 'down' && after.id !== before?.id).toBe(false);
    }));

  it('never counts player checks toward health (S19 PC7)', () =>
    isolated(async (tx) => {
      const before = await standing(tx);
      // Counted, the checks would make two operations erring in a row (S18 HE3): down.
      await tx.insert(supplierCalls).values(
        Array.from({ length: 6 }, (_, index) => ({
          id: newId(),
          supplierId: ids.fake,
          operation: index % 2 === 0 ? ('get_order' as const) : ('validate_player' as const),
          result: 'error' as const,
          latencyMs: 5_000,
          failureKind: 'timeout',
        })),
      );
      await health.check(new Date(), tx);
      const after = await standing(tx);
      expect(after?.state === 'down' && after.id !== before?.id).toBe(false);
    }));

  it('waits again after a failed probe', () =>
    isolated(async (tx) => {
      await tx.insert(supplierHealthChanges).values({
        id: newId(),
        supplierId: ids.fake,
        state: 'down',
        reason: '3 consecutive errors',
        // The probe is due two seconds ago: calls other test files committed before that (they
        // stay, append-only) fall inside the wait and count for nothing (rule H3).
        createdAt: new Date(
          Date.now() - SUPPLIER_POLICY_DEFAULTS.probeAfterMinutes * 60_000 - 2_000,
        ),
      });
      let probes = 0;
      current = {
        getBalance: async () => {
          probes += 1;
          throw new SupplierError('retryable', 'Timed out');
        },
      };
      await health.check(new Date(), tx);
      await health.check(new Date(), tx);
      expect(probes).toBe(1);
      expect((await standing(tx))?.state).toBe('down');
    }));

  it('reprices products whose cost went stale and reports a failing sync once (SY5)', () =>
    isolated(async (tx) => {
      const [p1, p2] = [await product(tx), await product(tx)];
      current = listing(offer('a', 0.88), offer('b', 0.9));
      await sync.sync(payload(), tx);
      await route(tx, p1, (await offerRow(tx, 'a')).id);
      const manual = await manualRoute(tx, p1, 1.2);
      await route(tx, p2, (await offerRow(tx, 'b')).id);
      await tx
        .update(supplierOffers)
        .set({ costConfirmedAt: new Date(Date.now() - 3 * 3_600_000) })
        .where(
          and(eq(supplierOffers.supplierId, ids.fake), like(supplierOffers.offerId, `w-${run}-%`)),
        );
      const first = await failedRun(tx, new Date(Date.now() + 1_000));
      await failedRun(tx, new Date(Date.now() + 2_000));
      await failedRun(tx, new Date(Date.now() + 3_000));

      await health.check(new Date(), tx);
      expect(await latestPrice(tx, p1)).toMatchObject({ routeId: manual, cause: 'route_change' });
      const stale = await routing(tx, p2);
      expect(stale?.availability).toBe('out_of_stock');
      expect(stale?.routes[0]?.unusableReason).toBe('cost_stale');
      const report = await message(tx, `sync-stale:fake:${first.id}`);
      expect(report?.params).toEqual({
        reason: 'costs_stale',
        supplier: 'fake',
        supplierNameAr: 'مورد تجريبي',
        unavailableProducts: 1,
      });
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
      sent.length = 0;
      // Audit A05-17: the product left on its stale cost is not locked and repriced again.
      const relocked = vi.spyOn(health as never, 'repriceStaleProducts' as never);
      await health.check(new Date(), tx);
      expect(relocked).not.toHaveBeenCalled();
      relocked.mockRestore();
      expect(await messages(tx, 'supplier_sync_failing')).toHaveLength(1);
      // S09 rule SF4: costs stale for long and nothing repriced: the store is not refreshed again,
      // until a cost goes stale anew.
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(false);
      await tx
        .update(supplierOffers)
        .set({
          costConfirmedAt: new Date(
            Date.now() - SUPPLIER_POLICY_DEFAULTS.costStaleMinutes * 60_000 - 30_000,
          ),
        })
        .where(
          and(eq(supplierOffers.supplierId, ids.fake), eq(supplierOffers.offerId, offerKey('b'))),
        );
      await health.check(new Date(), tx);
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
    }));
});

describe('suppliers.health: stale costs of a supplier down (audit F9-10)', () => {
  it('reports the stale costs even when the supplier is down after the same failures', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 0.88));
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'a')).id);
      await tx
        .update(supplierOffers)
        .set({ costConfirmedAt: new Date(Date.now() - 3 * 3_600_000) })
        .where(
          and(eq(supplierOffers.supplierId, ids.fake), like(supplierOffers.offerId, `w-${run}-%`)),
        );
      await tx.insert(supplierHealthChanges).values({
        id: newId(),
        supplierId: ids.fake,
        state: 'down',
        reason: '3 consecutive errors',
        createdAt: new Date(Date.now() - 60_000),
      });
      const first = await failedRun(tx, new Date(Date.now() + 1_000));
      await failedRun(tx, new Date(Date.now() + 2_000));
      await failedRun(tx, new Date(Date.now() + 3_000));

      await health.check(new Date(), tx);
      expect((await routing(tx, p))?.routes[0]?.unusableReason).toBe('supplier_down');
      expect((await message(tx, `sync-stale:fake:${first.id}`))?.params).toMatchObject({
        reason: 'costs_stale',
        unavailableProducts: 1,
      });
    }));
});

describe('suppliers.balances (rule H5)', () => {
  const balance = (dollars: number): Partial<SupplierAdapter> => ({
    getBalance: async (): Promise<SupplierMoney> => ({
      currency: 'USD',
      amountUnits: usd(dollars),
    }),
  });

  it('reads the balance, excludes routes it cannot pay, and alerts once, then on recovery', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 25));
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'a')).id);
      expect((await routing(tx, p))?.availability).toBe('available');

      current = balance(20);
      sent.length = 0;
      await balances.readAll(tx);
      // S09 rule SF4: the balance crossed the offer's cost, so the store's prices changed.
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
      const [read] = await tx
        .select()
        .from(supplierBalanceReads)
        .where(eq(supplierBalanceReads.supplierId, ids.fake))
        .orderBy(desc(supplierBalanceReads.createdAt))
        .limit(1);
      expect(read).toMatchObject({ currency: 'USD', amountUnits: usd(20) });
      const state = await routing(tx, p);
      expect(state?.availability).toBe('out_of_stock');
      expect(state?.routes[0]?.unusableReason).toBe('balance_low');
      const low = await message(tx, `balance:fake:${read?.createdAt.toISOString()}`);
      expect(low?.params).toEqual({
        supplier: 'fake',
        supplierNameAr: 'مورد تجريبي',
        currency: 'USD',
        amountUnits: usd(20),
        thresholdUsdUnits: usd(50),
        recovered: false,
      });
      await balances.readAll(tx);
      expect(await messages(tx, 'supplier_balance_low')).toHaveLength(1);

      current = balance(100);
      await balances.readAll(tx);
      expect(
        (await message(tx, `balance:fake:${read?.createdAt.toISOString()}:recovered`))?.params,
      ).toMatchObject({ amountUnits: usd(100), recovered: true });
      expect((await routing(tx, p))?.availability).toBe('available');
      expect(await messages(tx, 'supplier_balance_low')).toHaveLength(2);

      // A failed read leaves the last balance standing; health judges the call.
      current = {
        getBalance: async () => {
          throw new SupplierError('retryable', 'Timed out');
        },
      };
      await balances.readAll(tx);
      expect(await messages(tx, 'supplier_balance_low')).toHaveLength(2);
    }));

  it('repeats the low balance message every 6 hours while it stays low', () =>
    isolated(async (tx) => {
      current = balance(10);
      await balances.readAll(tx);
      const [first] = await messages(tx, 'supplier_balance_low');
      await balances.readAll(tx, new Date(Date.now() + 5 * 3_600_000));
      await balances.readAll(tx, new Date(Date.now() + 7 * 3_600_000));
      await balances.readAll(tx, new Date(Date.now() + 13 * 3_600_000));
      expect((await messages(tx, 'supplier_balance_low')).map((row) => row.dedupeKey)).toEqual([
        first?.dedupeKey,
        `${first?.dedupeKey}:1`,
        `${first?.dedupeKey}:2`,
      ]);
    }));

  it('follows a threshold change under a steady balance (audit F9-9)', () =>
    isolated(async (tx) => {
      const threshold = (dollars: number) =>
        tx
          .update(suppliers)
          .set({ lowBalanceUsdUnits: usd(dollars) })
          .where(eq(suppliers.id, ids.fake));
      current = balance(6);
      await balances.readAll(tx);
      const [low] = await messages(tx, 'supplier_balance_low');
      // Lowered under the balance: the next read is back above it.
      await threshold(5);
      await balances.readAll(tx);
      await balances.readAll(tx);
      // Raised above it again: a new streak, with a key of its own, sent at once.
      await threshold(50);
      await balances.readAll(tx);
      await balances.readAll(tx);
      const sentNow = await messages(tx, 'supplier_balance_low');
      expect(sentNow.map((row) => (row.params as { recovered: boolean }).recovered)).toEqual([
        false,
        true,
        false,
      ]);
      expect(sentNow[1]?.dedupeKey).toBe(`${low?.dedupeKey}:recovered`);
      expect(sentNow[2]?.dedupeKey).not.toBe(low?.dedupeKey);
      expect(sentNow[2]?.dedupeKey).toMatch(/^balance:fake:/);
    }));
});

describe('suppliers.balances: the plan (S19 FC9)', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');
  const account = (plan: SupplierAccount): Partial<SupplierAdapter> => ({
    capabilities: { ...ACCOUNT_CAPABILITIES },
    getBalance: async () => ({ currency: 'USD', amountUnits: usd(1_000_000) }),
    getAccount: async () => plan,
  });
  const supplierRow = async (tx: Transaction) =>
    (await tx.select().from(suppliers).where(eq(suppliers.id, ids.fake)))[0];

  it('keeps the plan, warns 48 hours before it ends once, and stops routes while inactive', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('plan', 2));
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'plan')).id);
      const expiresAt = new Date('2026-10-21T22:00:00Z');

      current = account({ plan: 'bronze', active: true, expiresAt, autoRenew: false });
      await balances.readAll(tx, NOW);
      expect(await supplierRow(tx)).toMatchObject({
        accountPlan: 'bronze',
        accountActive: true,
        accountAutoRenew: false,
        accountPlanExpiresAt: expiresAt,
        accountCheckedAt: NOW,
        planExpiryAlertedFor: expiresAt,
      });
      const expiring = await message(tx, `subscription:fake:expiring:${expiresAt.toISOString()}`);
      expect(expiring?.params).toEqual({
        supplier: 'fake',
        supplierNameAr: 'مورد تجريبي',
        reason: 'expiring',
        plan: 'bronze',
        expiresAt: expiresAt.toISOString(),
      });
      await balances.readAll(tx, new Date(NOW.getTime() + 300_000));
      expect(await messages(tx, 'supplier_subscription')).toHaveLength(1);

      current = account({ plan: 'bronze', active: false });
      sent.length = 0;
      await balances.readAll(tx, new Date(NOW.getTime() + 600_000));
      expect((await routing(tx, p))?.routes[0]?.unusableReason).toBe('supplier_paused');
      expect(sent.some((job) => job.queue === QUEUES.storeRevalidate)).toBe(true);
      await balances.readAll(tx, new Date(NOW.getTime() + 900_000));
      expect(
        (await messages(tx, 'supplier_subscription')).map(
          (row) => (row.params as { reason: string }).reason,
        ),
      ).toEqual(['expiring', 'inactive']);

      current = account({ plan: 'silver', active: true });
      await balances.readAll(tx, new Date(NOW.getTime() + 1_200_000));
      expect((await routing(tx, p))?.routes[0]?.unusableReason).toBeNull();
      expect(
        (await messages(tx, 'supplier_subscription')).map(
          (row) => (row.params as { reason: string }).reason,
        ),
      ).toEqual(['expiring', 'inactive', 'active']);
      expect(await supplierRow(tx)).toMatchObject({ accountPlan: 'silver', accountActive: true });

      // A failed read changes nothing; an adapter without the capability is not asked.
      current = {
        capabilities: { ...ACCOUNT_CAPABILITIES },
        getBalance: async () => ({ currency: 'USD', amountUnits: usd(1_000_000) }),
        getAccount: async () => {
          throw new SupplierError('retryable', 'Timed out');
        },
      };
      expect(await balances.readAccount(tx, await fakeState(tx), NOW)).toBe(false);
      current = { getAccount: async () => ({ plan: 'gold', active: false }) };
      expect(await balances.readAccount(tx, await fakeState(tx), NOW)).toBe(false);
      expect(await supplierRow(tx)).toMatchObject({ accountPlan: 'silver', accountActive: true });
    }));
});

describe('suppliers: a refusal for an inactive plan (S19 FC5, FC9)', () => {
  const supplierRow = async (tx: Transaction) =>
    (await tx.select().from(suppliers).where(eq(suppliers.id, ids.fake)))[0];

  it('turns the plan inactive when the plan read itself is refused for it', () =>
    isolated(async (tx) => {
      current = {
        capabilities: { ...ACCOUNT_CAPABILITIES },
        getBalance: async () => ({ currency: 'USD', amountUnits: usd(1_000_000) }),
        getAccount: async () => {
          throw new SupplierError('retryable', 'Supplier answered HTTP 403', {
            status: 403,
            supplierCode: 'subscription_inactive',
          });
        },
      };
      expect(await balances.readAccount(tx, await fakeState(tx), new Date())).toBe(true);
      expect(await supplierRow(tx)).toMatchObject({ accountActive: false, accountPlan: 'unknown' });
      expect(
        (await messages(tx, 'supplier_subscription')).map(
          (row) => (row.params as { reason: string }).reason,
        ),
      ).toEqual(['inactive']);
    }));

  it('turns the plan inactive when a first send is refused for it, stopping the routes', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('inactive', 2));
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'inactive')).id);
      const applied = { applied: true, attempt: { supplierId: ids.fake } } as AppliedOutcome;
      const jobs = { ...context(), jobs: { send: async () => newId() } };
      const refused = (code: string) =>
        ({ status: 'failed', supplierErrorCode: code, reason: 'refused' }) as AttemptOutcome;
      expect(await markSubscriptionRefusal(tx, applied, refused('OUT_OF_STOCK'), jobs)).toBe(false);
      expect(
        await markSubscriptionRefusal(
          tx,
          { ...applied, applied: false },
          refused('subscription_inactive'),
          jobs,
        ),
      ).toBe(false);
      expect(
        await markSubscriptionRefusal(tx, applied, refused('subscription_inactive'), jobs),
      ).toBe(true);
      expect(await supplierRow(tx)).toMatchObject({ accountActive: false });
      expect((await routing(tx, p))?.routes[0]?.unusableReason).toBe('supplier_paused');
    }));
});

describe('the supplier registry (rules SP1, SP2)', () => {
  it('decrypts the newest credentials per call and scripts the fake from its state file', () =>
    isolated(async (tx) => {
      const real = new SupplierRegistry(env);
      const key = supplierKey(env.SUPPLIER_KEYS_SECRET);
      await tx.insert(supplierCredentials).values({
        id: newId(),
        supplierId: ids.fake,
        ciphertext: encryptCredentials(key, ids.fake, { webhookSecret: SECRET }),
        hints: {},
        adminId: newId(),
      });
      await writeFakeSupplierState(env.FAKE_SUPPLIER_STATE_FILE, {
        costs: { 'fake-uc-60': usd(0.92) },
        outOfStock: [],
        removed: ['fake-ff-100'],
        failSync: false,
        orderScripts: {},
        orders: {},
        errors: false,
        stockCounts: {},
        missingCategories: [],
        addedOffers: [],
        mirroredOffers: [],
      });
      const connected = await real.connect(tx, { id: ids.fake, code: 'fake' });
      expect(connected?.secrets).toEqual([SECRET]);
      const offers = (await connected?.adapter.listOffers()) ?? [];
      expect(offers).toHaveLength(13);
      expect(offers.find((item) => item.offerId === 'fake-uc-60')?.cost.amountUnits).toBe(
        usd(0.92),
      );
      // A ciphertext moved to another supplier does not decrypt.
      await tx.insert(supplierCredentials).values({
        id: newId(),
        supplierId: ids.wdgzone,
        ciphertext: encryptCredentials(key, ids.fake, { apiKey: SECRET, webhookSecret: SECRET }),
        hints: {},
        adminId: newId(),
      });
      await expect(real.connect(tx, { id: ids.wdgzone, code: 'wdgzone' })).rejects.toThrow();
      expect(await real.get('wdgzone', {})).toBeNull();
      expect(await real.get('wdgzone', { apiKey: SECRET })).toBeInstanceOf(WdgzoneAdapter);
      expect(await real.get('manual', {})).toBeNull();
      // S19 FC2, FC7: FazerCards needs its key and its webhook secret.
      expect(
        await real.get('fazercards', { apiKey: SECRET, webhookSecret: SECRET }),
      ).toBeInstanceOf(FazercardsAdapter);
      expect(await real.get('fazercards', { apiKey: SECRET })).toBeNull();
      await rm(env.FAKE_SUPPLIER_STATE_FILE, { force: true });
      expect((await (await real.get('fake', {}))?.listOffers())?.length).toBe(14);
    }));

  it('masks credentials and URL queries in messages', () => {
    expect(
      sanitizedMessage(new Error(`at https://x.example/a?token=${SECRET}#f: ${SECRET}`), [
        SECRET,
        'abc',
      ]),
    ).toBe('at https://x.example/a ***');
    expect(sanitizedMessage('x'.repeat(600), [])).toHaveLength(500);
  });
});

describe('the daily summary (S07 lines)', () => {
  it('counts open reviews, guarded products, unhealthy suppliers and low balances', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      current = listing(offer('a', 0.92));
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'a')).id);
      current = listing(offer('a', 1.1));
      await sync.sync(payload(), tx);
      await tx
        .insert(supplierHealthChanges)
        .values({ id: newId(), supplierId: ids.fake, state: 'degraded', reason: 'test' });
      await tx
        .insert(supplierBalanceReads)
        .values({ id: newId(), supplierId: ids.fake, currency: 'USD', amountUnits: usd(20) });
      const alerts = new TelegramAlerts(
        { source: 'test' },
        { configured: false, call: async () => null },
        async () => null,
      );
      const job = new DailySummaryJob(pgBoss, alerts, db, env);
      const summary = await job.contents(tx, new Date(), '2030-01-01');
      expect(summary.openReviews).toBeGreaterThanOrEqual(1);
      expect(summary.marginGuarded).toBeGreaterThanOrEqual(1);
      expect(summary.suppliersNotHealthy).toEqual([
        { supplierNameAr: 'مورد تجريبي', state: 'degraded' },
      ]);
      expect(summary.balancesLow).toEqual([
        { supplierNameAr: 'مورد تجريبي', currency: 'USD', amountUnits: usd(20) },
      ]);
      expect(TELEGRAM_MESSAGE_PARAMS.daily_summary.parse(summary)).toEqual(summary);
    }));

  it('repeats a failing sync and a lapsed plan every day they last (audit A05-13)', () =>
    isolated(async (tx) => {
      current = {
        listOffers: async () => {
          throw new SupplierError('retryable', 'timed out', { supplierCode: 'E_TIMEOUT' });
        },
      };
      for (let attempt = 0; attempt < 3; attempt += 1) await sync.sync(payload(), tx);
      await tx
        .update(suppliers)
        .set({
          accountPlan: 'trial',
          accountActive: false,
          accountCheckedAt: new Date(),
        })
        .where(eq(suppliers.id, ids.fake));
      const alerts = new TelegramAlerts(
        { source: 'test' },
        { configured: false, call: async () => null },
        async () => null,
      );
      const job = new DailySummaryJob(pgBoss, alerts, db, env);
      const summary = await job.contents(tx, new Date(), '2030-01-01');
      expect(summary.syncsFailing).toEqual([{ supplierNameAr: 'مورد تجريبي', failedRuns: 3 }]);
      expect(summary.plansInactive).toEqual(['مورد تجريبي']);
      const text = renderTelegramMessage('daily_summary', summary, LINKS).text;
      expect(text).toContain('مزامنة مورد تجريبي تفشل: 3 محاولات متتالية');
      expect(text).toContain('اشتراك مورد تجريبي غير نشط');
    }));
});

describe('the supplier messages', () => {
  const name = { supplier: 'wdgzone' as const, supplierNameAr: 'WDGZone' };
  const text = <Kind extends TelegramMessageKind>(
    kind: Kind,
    params: Parameters<typeof renderTelegramMessage<Kind>>[1],
  ) => renderTelegramMessage(kind, params, LINKS).text.split('\n');

  it('render the plan alerts in Arabic (S19 FC9)', () => {
    const plan = { supplier: 'fazercards' as const, supplierNameAr: 'FazerCards', plan: 'bronze' };
    const at = '2026-10-21T22:00:00.000Z';
    expect(text('supplier_subscription', { ...plan, reason: 'expiring', expiresAt: at })).toEqual([
      '⏰ اشتراك FazerCards (bronze) ينتهي 22/10 01:00: جدّده من لوحة المورد.',
      'http://127.0.0.1:5173/suppliers/fazercards',
    ]);
    expect(text('supplier_subscription', { ...plan, reason: 'inactive', expiresAt: null })[0]).toBe(
      '⛔ اشتراك FazerCards غير فعّال: أُوقفت طلباته وفحص اللاعبين حتى يُجدَّد.',
    );
    expect(text('supplier_subscription', { ...plan, reason: 'active', expiresAt: at })[0]).toBe(
      '✅ عاد اشتراك FazerCards (bronze) فعّالاً حتى 22/10 01:00.',
    );
    expect(text('supplier_subscription', { ...plan, reason: 'active', expiresAt: null })[0]).toBe(
      '✅ عاد اشتراك FazerCards (bronze) فعّالاً.',
    );
  });

  it('render the sync summary, health, balance and failing sync in Arabic', () => {
    expect(
      text('supplier_sync_summary', {
        ...name,
        runId: newId(),
        reviewsOpened: 3,
        marginGuarded: 2,
        mappedMissing: 1,
      }),
    ).toEqual([
      '🔄 مزامنة WDGZone: تغييرات أسعار للمراجعة: 3، باقات أوقفها حارس الهامش: 2، عروض مربوطة اختفت: 1',
      'http://127.0.0.1:5173/pricing/reviews',
    ]);
    expect(
      text('supplier_sync_summary', {
        ...name,
        runId: newId(),
        reviewsOpened: 0,
        marginGuarded: 0,
        mappedMissing: 2,
      }),
    ).toEqual([
      '🔄 مزامنة WDGZone: عروض مربوطة اختفت: 2',
      'http://127.0.0.1:5173/suppliers/wdgzone',
    ]);
    const healthText = (state: 'healthy' | 'degraded' | 'down', successBp: number | null) =>
      text('supplier_health', { ...name, state, previous: 'healthy', successBp })[0];
    expect(healthText('degraded', 8_250)).toBe('⚠️ WDGZone متراجع: نجاح 82%');
    expect(healthText('degraded', null)).toBe('⚠️ WDGZone متراجع');
    expect(healthText('down', 0)).toBe('⛔ WDGZone متوقف: نجاح 0%');
    expect(healthText('healthy', 10_000)).toBe('✅ WDGZone عاد سليماً');
    const balanceText = (recovered: boolean, currency: 'USD' | 'SYP' = 'USD') =>
      text('supplier_balance_low', {
        ...name,
        currency,
        amountUnits: currency === 'USD' ? usd(20) : 1_500_000,
        thresholdUsdUnits: usd(50),
        recovered,
      })[0];
    expect(balanceText(false)).toBe('💰 رصيد WDGZone تحت الحد: $20.00 (الحد $50.00)');
    expect(balanceText(true)).toBe('✅ رصيد WDGZone عاد إلى الحد أو فوقه: $20.00');
    expect(balanceText(true, 'SYP')).toContain('15,000');
    expect(
      text('supplier_sync_failing', {
        ...name,
        reason: 'runs_failed',
        failedRuns: 3,
        errorCode: 'E_TIMEOUT',
      })[0],
    ).toBe('⚠️ فشلت مزامنة WDGZone 3 مرات متتالية (E_TIMEOUT)');
    expect(
      text('supplier_sync_failing', {
        ...name,
        reason: 'runs_failed',
        failedRuns: 4,
        errorCode: null,
      })[0],
    ).toBe('⚠️ فشلت مزامنة WDGZone 4 مرات متتالية');
    expect(
      text('supplier_sync_failing', { ...name, reason: 'costs_stale', unavailableProducts: 14 })[0],
    ).toBe('⛔ أسعار WDGZone قديمة: 14 باقة غير متوفرة');
  });
});

describe('suppliers.sync: categories, offer fields and stock (S16 SC2, SC3, SF2)', () => {
  const tree = (...extra: { categoryId: string; parentCategoryId?: string; name: string }[]) => [
    {
      categoryId: `c-${run}-root`,
      name: 'PUBG Mobile',
      kind: 'direct' as const,
      productCount: 2,
      inStockCount: 1,
      imageUrl: 'https://fake-supplier.invalid/images/root.png',
    },
    { categoryId: `c-${run}-leaf`, parentCategoryId: `c-${run}-root`, name: 'Global' },
    ...extra,
  ];
  const catalogAdapter = (
    categories: () => Promise<unknown[]>,
    ...offers: SupplierOffer[]
  ): Partial<SupplierAdapter> => ({
    capabilities: {
      balance: true,
      catalog: true,
      categories: true,
      statement: false,
      platformStatus: false,
      validatePlayer: false,
      webhooks: false,
      offerQuote: false,
      offerWindow: false,
      account: false,
    },
    listCategories: categories as SupplierAdapter['listCategories'],
    listOffers: async () => offers,
  });
  const categoryRows = (tx: Transaction) =>
    tx
      .select()
      .from(supplierCategories)
      .where(like(supplierCategories.categoryId, `c-${run}-%`))
      .orderBy(asc(supplierCategories.categoryId));

  it('reads categories before offers, mirrors them and marks missing ones', () =>
    isolated(async (tx) => {
      const leafOffer = offer('tree', 1, {
        categoryId: `c-${run}-leaf`,
        stock: 7,
        originalCost: { currency: 'USD', amountUnits: usd(1.2) },
        fieldSpecs: [{ key: 'playerId', label: 'Player ID', type: 'text' }],
      });
      const twoFields = offer('two', 1, {
        categoryId: `c-${run}-leaf`,
        requiredFields: ['user_id', 'server_id'],
        unsupportedReason: 'fields_unsupported',
      });
      const calls: string[] = [];
      current = {
        ...catalogAdapter(
          async () => {
            calls.push('categories');
            return tree(
              { categoryId: `c-${run}-gone`, name: 'Old' },
              { categoryId: '', name: 'x' },
            );
          },
          leafOffer,
          twoFields,
        ),
      };
      const listOffers = current.listOffers as () => Promise<SupplierOffer[]>;
      current.listOffers = async () => {
        calls.push('offers');
        return listOffers();
      };
      const first = await sync.sync(payload(), tx);
      expect(first).toMatchObject({ status: 'succeeded', categoriesSkipped: false });
      expect(calls).toEqual(['categories', 'offers']);
      const rows = await categoryRows(tx);
      expect(rows.map((row) => [row.categoryId, row.parentCategoryId, row.missingSince])).toEqual([
        [`c-${run}-gone`, null, null],
        [`c-${run}-leaf`, `c-${run}-root`, null],
        [`c-${run}-root`, null, null],
      ]);
      expect(rows[2]).toMatchObject({
        name: 'PUBG Mobile',
        kind: 'direct',
        productCount: 2,
        inStockCount: 1,
        imageUrl: 'https://fake-supplier.invalid/images/root.png',
        lastSeenAt: first?.startedAt,
      });
      expect(await offerRow(tx, 'tree')).toMatchObject({
        categoryId: `c-${run}-leaf`,
        stock: 7,
        originalCostUsdUnits: usd(1.2),
        fieldSpecs: [{ key: 'playerId', label: 'Player ID', type: 'text' }],
        unsupportedReason: null,
      });
      expect(await offerRow(tx, 'two')).toMatchObject({ unsupportedReason: 'fields_unsupported' });
      const calledCategories = await tx
        .select()
        .from(supplierCalls)
        .where(
          and(
            eq(supplierCalls.supplierId, ids.fake),
            eq(supplierCalls.operation, 'list_categories'),
          ),
        );
      expect(calledCategories.length).toBeGreaterThan(0);

      // The node is no longer listed: kept, missing since this run; the link would stay.
      await tx
        .update(supplierCategories)
        .set({ ignoredAt: new Date() })
        .where(eq(supplierCategories.categoryId, `c-${run}-gone`));
      current = catalogAdapter(async () => tree(), leafOffer, twoFields);
      const second = await sync.sync(payload(), tx);
      const gone = (await categoryRows(tx))[0];
      expect(gone?.missingSince).toEqual(second?.startedAt);
      expect(gone?.ignoredAt).not.toBeNull();

      // A failed or empty category read keeps the tree; the run goes on with offers.
      for (const read of [
        async () => {
          throw new SupplierError('retryable', 'Categories timed out');
        },
        async () => [],
      ]) {
        current = catalogAdapter(read, leafOffer, twoFields);
        const skipped = await sync.sync(payload(), tx);
        expect(skipped).toMatchObject({ status: 'succeeded', categoriesSkipped: true });
        expect((await categoryRows(tx)).map((row) => row.missingSince === null)).toEqual([
          false,
          true,
          true,
        ]);
      }
    }));

  it('alerts low and out stock of mapped active packs once per level, again after recovery', () =>
    isolated(async (tx) => {
      const p = await product(tx);
      await tx.execute(sql`update catalog_products set status = 'active' where id = ${p}`);
      const stocked = (stock: number | undefined, inStock = true) =>
        listing(offer('stock', 1, { stock, inStock }), offer('plain', 1));
      current = stocked(50);
      await sync.sync(payload(), tx);
      await route(tx, p, (await offerRow(tx, 'stock')).id);
      // A paused product's offer never alerts.
      const pausedProduct = await product(tx);
      await tx.execute(
        sql`update catalog_products set status = 'paused' where id = ${pausedProduct}`,
      );
      await route(tx, pausedProduct, (await offerRow(tx, 'plain')).id);

      const runs: (typeof supplierSyncRuns.$inferSelect | null)[] = [];
      for (const [stock, inStock] of [
        [5, true],
        [4, true],
        [20, true],
        [5, true],
        [0, true],
        [undefined, false],
      ] as const) {
        current = stocked(stock, inStock);
        runs.push(await sync.sync(payload(), tx));
      }
      // One after another: the transaction's client runs one query at a time.
      const alerted: unknown[] = [];
      for (const one of runs) alerted.push((await message(tx, `stock:${one?.id}`))?.params);
      expect(alerted.map((params) => params !== undefined)).toEqual([
        true, // ok → low
        false, // low stays low
        false, // back at the threshold: cleared
        true, // low again
        true, // low → out
        false, // out stays out
      ]);
      expect(alerted[0]).toMatchObject({
        supplier: 'fake',
        offers: [{ level: 'low', stock: 5 }],
        more: 0,
      });
      expect(alerted[4]).toMatchObject({ offers: [{ level: 'out', stock: 0 }] });
      expect((await offerRow(tx, 'stock')).stockAlert).toBe('out');
      expect((await offerRow(tx, 'plain')).stockAlert).toBeNull();
      const text = renderTelegramMessage(
        'supplier_stock_low',
        alerted[0] as TelegramMessageParams<'supplier_stock_low'>,
        LINKS,
      ).text;
      expect(text).toContain('مخزون منخفض في مورد تجريبي');
      expect(text).toContain('(5 متبقية)');

      // The route is archived: the offer no longer counts and its alert is cleared.
      await tx
        .update(productRoutes)
        .set({ archivedAt: new Date() })
        .where(eq(productRoutes.productId, p));
      current = stocked(5);
      await sync.sync(payload(), tx);
      expect((await offerRow(tx, 'stock')).stockAlert).toBeNull();
    }));
});

describe('suppliers.sync: a category window (S19 FC3)', () => {
  const cat = (name: string) => `c-${run}-w${name}`;
  const windowed = (
    categories: () => Promise<{ categoryId: string; name: string; kind?: string }[]>,
    read: (ids: readonly string[]) => { offers: SupplierOffer[]; readCategoryIds: string[] },
    asked: string[][],
  ): Partial<SupplierAdapter> => ({
    capabilities: {
      balance: true,
      catalog: true,
      categories: true,
      statement: false,
      platformStatus: false,
      validatePlayer: false,
      webhooks: false,
      offerQuote: false,
      offerWindow: true,
      account: false,
    },
    listCategories: categories as SupplierAdapter['listCategories'],
    listOffers: async () => {
      throw new Error('a windowed supplier is never read whole');
    },
    listOffersIn: async (ids) => {
      asked.push(ids.filter((id) => id.startsWith(`c-${run}-w`)));
      return read(ids);
    },
  });
  const offersOf = (ids: readonly string[], skip: string[] = []) =>
    ids
      .filter((id) => id.startsWith(`c-${run}-w`) && !skip.includes(id))
      .flatMap((id) => [
        offer(`${id}-1`, 1, { categoryId: id }),
        ...(id === cat('L') && skip.includes('drop-L2')
          ? []
          : [offer(`${id}-2`, 2, { categoryId: id })]),
      ]);
  const missing = async (tx: Transaction, name: string) =>
    (await offerRow(tx, name)).missingSince !== null;

  it('reads linked and mapped categories first, then the oldest read; misses only what it read', () =>
    isolated(async (tx) => {
      // Other tests' categories of the fake supplier stay out of this window.
      await tx.execute(
        sql`update supplier_categories set ignored_at = now(), game_id = null, linked_at = null
          where supplier_id = ${ids.fake} and category_id not like ${`c-${run}-w%`}`,
      );
      const asked: string[][] = [];
      const calls: string[] = [];
      const list = [cat('L'), cat('U1'), cat('U2')];
      let listed = list;
      const categories = async () => {
        calls.push('categories');
        return listed.map((categoryId) => ({ categoryId, name: categoryId }));
      };
      // Run 1: no list yet, so it is read; every category is in the rolling part.
      current = windowed(
        categories,
        (ids) => ({ offers: offersOf(ids), readCategoryIds: [...ids] }),
        asked,
      );
      expect(await sync.sync(payload(), tx)).toMatchObject({
        status: 'succeeded',
        categoriesSkipped: false,
      });
      expect(calls).toEqual(['categories']);
      expect(asked[0]).toEqual(list);
      const first = await tx
        .select()
        .from(supplierCategories)
        .where(eq(supplierCategories.categoryId, cat('U2')));
      expect(first[0]?.offersReadAt).not.toBeNull();

      // Run 2: the list is fresh (not read); L is linked, so it comes first. U2 fails, and L no
      // longer lists its second pack: only L's pack goes missing.
      const p = await product(tx);
      const [{ gameId } = { gameId: '' }] = await tx
        .select({ gameId: catalogProducts.gameId })
        .from(catalogProducts)
        .where(eq(catalogProducts.id, p));
      await tx
        .update(supplierCategories)
        .set({ gameId, linkedAt: new Date() })
        .where(eq(supplierCategories.categoryId, cat('L')));
      current = windowed(
        categories,
        (ids) => ({
          offers: offersOf(ids, [cat('U2'), 'drop-L2']),
          readCategoryIds: ids.filter((id) => id !== cat('U2')),
        }),
        asked,
      );
      expect(await sync.sync(payload(), tx)).toMatchObject({
        status: 'succeeded',
        categoriesSkipped: false,
      });
      expect(calls).toEqual(['categories']);
      expect(asked[1]?.[0]).toBe(cat('L'));
      expect(await missing(tx, `${cat('L')}-2`)).toBe(true);
      expect(await missing(tx, `${cat('L')}-1`)).toBe(false);
      expect(await missing(tx, `${cat('U2')}-1`)).toBe(false);

      // Run 3, "sync now": the list is read again and U1 left it: its packs go missing although
      // the window no longer reads it; U2 (read longest ago) comes before nothing else.
      listed = [cat('L'), cat('U2')];
      current = windowed(
        categories,
        (ids) => ({ offers: offersOf(ids), readCategoryIds: [...ids] }),
        asked,
      );
      const third = await sync.sync({ ...payload(), trigger: 'admin' }, tx);
      expect(third).toMatchObject({ status: 'succeeded' });
      expect(calls).toEqual(['categories', 'categories']);
      expect(asked[2]).toEqual([cat('L'), cat('U2')]);
      expect(await missing(tx, `${cat('U1')}-1`)).toBe(true);
      expect(await missing(tx, `${cat('L')}-2`)).toBe(false);
      const u1 = await tx
        .select()
        .from(supplierCategories)
        .where(eq(supplierCategories.categoryId, cat('U1')));
      expect(u1[0]?.missingSince).toEqual(third?.startedAt);
    }));

  it('reads top-up categories before gift cards at equal read time', () =>
    isolated(async (tx) => {
      await tx.execute(
        sql`update supplier_categories set ignored_at = now(), game_id = null, linked_at = null
          where supplier_id = ${ids.fake} and category_id not like ${`c-${run}-k%`}`,
      );
      const kinded = (name: string) => `c-${run}-k${name}`;
      const asked: string[][] = [];
      current = {
        ...windowed(
          async () => [
            { categoryId: kinded('A-gift'), name: 'A', kind: 'code' },
            { categoryId: kinded('B-gift'), name: 'B', kind: 'code' },
            { categoryId: kinded('Z-topup'), name: 'Z', kind: 'direct' },
          ],
          () => ({ offers: [], readCategoryIds: [] }),
          asked,
        ),
        listOffersIn: async (window) => {
          asked.push([...window]);
          return {
            offers: window.map((id) => offer(`${id}-1`, 1, { categoryId: id })),
            readCategoryIds: [...window],
          };
        },
      };
      expect(await sync.sync(payload(), tx)).toMatchObject({ status: 'succeeded' });
      expect(asked[0]).toEqual([kinded('Z-topup'), kinded('A-gift'), kinded('B-gift')]);
    }));

  it('fails the run when the window could not be read, changing nothing', () =>
    isolated(async (tx) => {
      current = {
        ...windowed(
          async () => [{ categoryId: cat('F'), name: 'F' }],
          () => ({ offers: [], readCategoryIds: [] }),
          [],
        ),
        listOffersIn: async () => {
          throw new SupplierError('retryable', 'Timed out', { failure: 'timeout' });
        },
      };
      expect(await sync.sync(payload(), tx)).toMatchObject({ status: 'failed' });
    }));
});
