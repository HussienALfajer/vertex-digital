import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import {
  HEALTH_PROBE_REASON,
  priceFromCost,
  QUEUES,
  SUPPLIER_POLICY_DEFAULTS,
  TELEGRAM_MESSAGE_PARAMS,
  type TelegramMessageKind,
} from '@vertex-digital/contracts';
import {
  createDatabase,
  encryptCredentials,
  newId,
  priceReviews,
  productPrices,
  productRoutes,
  productRoutingStates,
  repriceProducts,
  supplierBalanceReads,
  supplierCalls,
  supplierCostChanges,
  supplierCredentials,
  supplierHealthChanges,
  supplierKey,
  supplierOffers,
  supplierPolicy,
  supplierSyncRuns,
  suppliers,
  type Transaction,
  telegramMessages,
} from '@vertex-digital/db';
import {
  type SupplierAdapter,
  SupplierError,
  type SupplierMoney,
  type SupplierOffer,
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
import { SupplierBalancesJob } from '../src/jobs/suppliers/balances.job.js';
import { SupplierHealthJob } from '../src/jobs/suppliers/health.job.js';
import { listedOffers, SupplierSyncJob } from '../src/jobs/suppliers/sync.job.js';
import { SupplierSyncScheduleJob } from '../src/jobs/suppliers/sync-schedule.job.js';
import { DailySummaryJob } from '../src/jobs/telegram/daily-summary.job.js';
import { writeFakeSupplierState } from '../src/suppliers/fake-state-file.js';
import { sanitizedMessage } from '../src/suppliers/supplier-calls.js';
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

const ids = { fake: '', manual: '', wdgzone: '' };

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
const health = new SupplierHealthJob(pgBoss, registry, db, env);
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

beforeAll(async () => {
  const rows = await db.select({ id: suppliers.id, code: suppliers.code }).from(suppliers);
  for (const row of rows) {
    if (row.code === 'fake' || row.code === 'manual' || row.code === 'wdgzone') {
      ids[row.code] = row.id;
    }
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
    sql`insert into margin_rules (id, scope, target_id, percent_bp, fixed_usd_units,
      min_margin_usd_units) values (${newId()}, 'product', ${id}, ${RULE.percentBp},
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
      .where(eq(productPrices.productId, productId))
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

      const [lost] = await tx
        .insert(supplierSyncRuns)
        .values({
          id: newId(),
          supplierId: ids.fake,
          trigger: 'schedule',
          startedAt: new Date(Date.now() - 11 * 60_000),
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

  it('fails a run of a supplier without an adapter here (edge case 14)', () =>
    isolated(async (tx) => {
      await tx.insert(supplierCredentials).values({
        id: newId(),
        supplierId: ids.wdgzone,
        ciphertext: Buffer.from([0]),
        hints: {},
        adminId: newId(),
      });
      const [run] = await tx
        .insert(supplierSyncRuns)
        .values({ id: newId(), supplierId: ids.wdgzone, trigger: 'admin' })
        .returning();
      expect(
        await sync.sync(
          { supplierId: ids.wdgzone, supplierCode: 'wdgzone', trigger: 'admin', runId: run?.id },
          tx,
        ),
      ).toMatchObject({ status: 'failed', errorCode: 'SUPPLIER_UNAVAILABLE' });
    }));

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

describe('suppliers.sync-schedule (rule SY1)', () => {
  it('queues a sync for each configured, available supplier with a catalog', () =>
    isolated(async (tx) => {
      const queued = await schedule.enqueue(tx);
      expect(queued.map((job) => job.supplierCode)).toEqual(['fake']);
      expect(sent).toEqual([
        {
          queue: QUEUES.suppliersSync,
          data: { supplierId: ids.fake, supplierCode: 'fake', trigger: 'schedule' },
          options: { retryLimit: 0 },
        },
      ]);
    }));
});

describe('suppliers.health (rules H1–H4, SY5)', () => {
  const calls = (tx: Transaction, ...results: ('ok' | 'error')[]) =>
    tx.insert(supplierCalls).values(
      results.map((result) => ({
        id: newId(),
        supplierId: ids.fake,
        operation: 'get_balance' as const,
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

      await calls(tx, 'error', 'error', 'error');
      const checkedAt = new Date();
      await health.check(checkedAt, tx);
      const down = await standing(tx);
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

      // Healthy only once the calls since the probe meet the rules with the minimum count.
      await calls(tx, 'ok', 'ok', 'ok', 'ok');
      await health.check(new Date(), tx);
      expect((await standing(tx))?.state).toBe('degraded');
      await calls(tx, 'ok');
      await health.check(new Date(), tx);
      expect(await standing(tx)).toMatchObject({ state: 'healthy', reason: 'success 100%' });
      expect(await latestPrice(tx, p)).toMatchObject({ routeId: fakeRoute });
      const states = (await messages(tx, 'supplier_health')).map(
        (row) => (row.params as { state: string }).state,
      );
      expect(states).toEqual(['down', 'degraded', 'healthy']);
    }));

  it('waits again after a failed probe', () =>
    isolated(async (tx) => {
      await tx.insert(supplierHealthChanges).values({
        id: newId(),
        supplierId: ids.fake,
        state: 'down',
        reason: '3 consecutive errors',
        createdAt: new Date(Date.now() - 11 * 60_000),
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
      await health.check(new Date(), tx);
      expect(await messages(tx, 'supplier_sync_failing')).toHaveLength(1);
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
      await balances.readAll(tx);
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
      });
      const connected = await real.connect(tx, { id: ids.fake, code: 'fake' });
      expect(connected?.secrets).toEqual([SECRET]);
      const offers = (await connected?.adapter.listOffers()) ?? [];
      expect(offers).toHaveLength(9);
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
      expect(await real.get('manual', {})).toBeNull();
      await rm(env.FAKE_SUPPLIER_STATE_FILE, { force: true });
      expect((await (await real.get('fake', {}))?.listOffers())?.length).toBe(10);
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
});

describe('the supplier messages', () => {
  const name = { supplier: 'wdgzone' as const, supplierNameAr: 'WDGZone' };
  const text = <Kind extends TelegramMessageKind>(
    kind: Kind,
    params: Parameters<typeof renderTelegramMessage<Kind>>[1],
  ) => renderTelegramMessage(kind, params, LINKS).text.split('\n');

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
