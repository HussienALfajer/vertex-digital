import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { isOpenAttempt, type OrderPolicy, pastHardLimit, QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  catalogGames,
  catalogProducts,
  currentOrderPolicy,
  type Database,
  expireReservations,
  fulfilmentAttempts,
  lockOrder,
  notifyCustomer,
  orders,
  playerChecks,
  queueFulfil,
  queuePoll,
  queueTelegramMessage,
  suppliers,
  type Transaction,
  transitionOrder,
} from '@vertex-digital/db';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, notExists } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

type Executor = Database | Transaction;

/** Every minute (rule F6). */
export const ORDERS_SWEEP_CRON = '* * * * *';

/** A `sending` attempt older than this was left by a crash; a poll this late was lost. */
export const SWEEP_GRACE_MS = 60_000;

/** At most this many rows per step and run; the next minute takes the rest. */
const BATCH = 100;

/** A player check is deleted this long after it expired (S09 "Data", `player_checks`). */
export const PLAYER_CHECK_KEEP_MS = 24 * 60 * 60_000;

const OPEN = ['sending', 'pending', 'unknown'] as const;

export interface SweepResult {
  resent: string[];
  polled: string[];
  held: string[];
  reminded: string[];
  fulfilled: string[];
  expired: string[];
  checksDeleted: string[];
}

/**
 * `orders.sweep` (S08 rules F6, F7, MN2), every minute: what a crash or a lost job left behind is
 * queued again, all through the jobs that own it (`orders.poll` re-sends a `sending` attempt with
 * its key; `orders.fulfil` routes); automatic attempts past the hard limit put their order in
 * `needs_review` (the admin's Telegram alert, the customer's "delayed"); open manual attempts get
 * their one reminder. Every change is made under the order lock, after reading it again. S09:
 * reservations past their deadline are cancelled (rule RS7, `FOR UPDATE SKIP LOCKED`, so a
 * payment in progress keeps its order), and player checks expired for a day are deleted.
 */
@Injectable()
export class OrdersSweepJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersSweepJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.ordersSweep, async () => {
      const result = await this.sweep();
      const changed = Object.entries(result).filter(([, ids]) => ids.length > 0);
      if (changed.length > 0) {
        this.logger.log(
          `Sweep: ${changed.map(([step, ids]) => `${step} ${ids.length}`).join(', ')}`,
        );
      }
    });
    await this.pgBoss.boss.schedule(QUEUES.ordersSweep, ORDERS_SWEEP_CRON);
    this.logger.log(`Scheduled ${QUEUES.ordersSweep} (${ORDERS_SWEEP_CRON})`);
  }

  async sweep(now = new Date(), db: Executor = this.db): Promise<SweepResult> {
    const policy = await currentOrderPolicy(db);
    const late = new Date(now.getTime() - SWEEP_GRACE_MS);
    return {
      resent: await this.queuePolls(
        db,
        now,
        eq(fulfilmentAttempts.status, 'sending'),
        lt(fulfilmentAttempts.sentAt, late),
      ),
      polled: await this.queuePolls(
        db,
        now,
        inArray(fulfilmentAttempts.status, ['pending', 'unknown']),
        lt(fulfilmentAttempts.nextPollAt, late),
      ),
      held: await this.hold(db, now, policy),
      reminded: await this.remind(db, now, policy),
      fulfilled: await this.queueFulfils(db, late),
      expired: await expireReservations(
        db as Database,
        { jobs: bossJobSender(this.pgBoss.boss) },
        BATCH,
      ),
      checksDeleted: await this.deleteChecks(db, now),
    };
  }

  /** The player-check cache keeps no row a day past its expiry (S09 "Data"). */
  private async deleteChecks(db: Executor, now: Date): Promise<string[]> {
    const rows = await db
      .delete(playerChecks)
      .where(lt(playerChecks.expiresAt, new Date(now.getTime() - PLAYER_CHECK_KEEP_MS)))
      .returning({ id: playerChecks.id });
    return rows.map((row) => row.id);
  }

  /** Rule F6: a poll for automatic attempts that match (a lost send or a lost poll). */
  private async queuePolls(
    db: Executor,
    now: Date,
    ...conditions: ReturnType<typeof eq>[]
  ): Promise<string[]> {
    const rows = await db
      .select({ id: fulfilmentAttempts.id })
      .from(fulfilmentAttempts)
      .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
      .where(and(ne(suppliers.code, 'manual'), ...conditions))
      .orderBy(asc(fulfilmentAttempts.sentAt))
      .limit(BATCH);
    if (rows.length === 0) return [];
    await db.transaction(async (tx) => {
      // `stately`: a poll already queued for an attempt makes this one a no-op.
      for (const row of rows) await queuePoll(tx, bossJobSender(this.pgBoss.boss), row.id, now);
    });
    return rows.map((row) => row.id);
  }

  /** Rule F7: an automatic attempt open past the hard limit holds its order for the admin. */
  private async hold(db: Executor, now: Date, policy: OrderPolicy): Promise<string[]> {
    const cutoff = new Date(now.getTime() - policy.hardLimitMinutes * 60_000);
    const rows = await db
      .select({ orderId: fulfilmentAttempts.orderId, attemptId: fulfilmentAttempts.id })
      .from(fulfilmentAttempts)
      .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
      .innerJoin(orders, eq(orders.id, fulfilmentAttempts.orderId))
      .where(
        and(
          ne(suppliers.code, 'manual'),
          inArray(fulfilmentAttempts.status, [...OPEN]),
          lte(fulfilmentAttempts.sentAt, cutoff),
          eq(orders.status, 'sent_to_supplier'),
        ),
      )
      .orderBy(asc(fulfilmentAttempts.sentAt))
      .limit(BATCH);
    const held: string[] = [];
    for (const row of rows) {
      const done = await db.transaction(async (tx) => {
        const order = await lockOrder(tx, row.orderId);
        const [attempt] = await tx
          .select({
            status: fulfilmentAttempts.status,
            sentAt: fulfilmentAttempts.sentAt,
            supplierNameAr: suppliers.nameAr,
          })
          .from(fulfilmentAttempts)
          .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
          .where(eq(fulfilmentAttempts.id, row.attemptId));
        if (
          order?.status !== 'sent_to_supplier' ||
          !attempt?.sentAt ||
          !isOpenAttempt(attempt.status) ||
          !pastHardLimit(attempt.sentAt, now, policy)
        ) {
          return false;
        }
        const changed = await transitionOrder(tx, order, 'needs_review', {
          actor: 'system',
          attemptId: row.attemptId,
          reason: 'hard_limit',
        });
        if (!changed) return false;
        const jobs = bossJobSender(this.pgBoss.boss);
        await queueTelegramMessage(tx, jobs, {
          kind: 'order_needs_review',
          params: {
            orderId: order.id,
            orderNumber: order.number,
            supplierNameAr: attempt.supplierNameAr,
            waitMinutes: Math.floor((now.getTime() - attempt.sentAt.getTime()) / 60_000),
          },
          dedupeKey: `review:${order.id}:${changed.reviewSince?.toISOString()}`,
        });
        await notifyCustomer(tx, jobs, {
          customerId: order.customerId,
          event: 'order_delayed',
          params: {
            orderId: order.id,
            orderNumber: order.number,
            productNameAr: await productName(tx, order.productId),
          },
        });
        return true;
      });
      if (done) held.push(row.orderId);
    }
    return held;
  }

  /** Rule MN2: one reminder per open manual attempt, `manual_reminder_minutes` after sending. */
  private async remind(db: Executor, now: Date, policy: OrderPolicy): Promise<string[]> {
    const cutoff = new Date(now.getTime() - policy.manualReminderMinutes * 60_000);
    const rows = await db
      .select({ orderId: fulfilmentAttempts.orderId, attemptId: fulfilmentAttempts.id })
      .from(fulfilmentAttempts)
      .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
      .where(
        and(
          eq(suppliers.code, 'manual'),
          eq(fulfilmentAttempts.status, 'pending'),
          isNull(fulfilmentAttempts.remindedAt),
          lte(fulfilmentAttempts.sentAt, cutoff),
        ),
      )
      .orderBy(asc(fulfilmentAttempts.sentAt))
      .limit(BATCH);
    const reminded: string[] = [];
    for (const row of rows) {
      const done = await db.transaction(async (tx) => {
        const order = await lockOrder(tx, row.orderId);
        const [attempt] = await tx
          .update(fulfilmentAttempts)
          .set({ remindedAt: now })
          .where(
            and(
              eq(fulfilmentAttempts.id, row.attemptId),
              eq(fulfilmentAttempts.status, 'pending'),
              isNull(fulfilmentAttempts.remindedAt),
              isNotNull(fulfilmentAttempts.sentAt),
            ),
          )
          .returning();
        if (!order || !attempt?.sentAt) return false;
        const [names] = await tx
          .select({ productNameAr: catalogProducts.nameAr, gameNameAr: catalogGames.nameAr })
          .from(catalogProducts)
          .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
          .where(eq(catalogProducts.id, order.productId));
        await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
          kind: 'manual_order_reminder',
          params: {
            orderId: order.id,
            orderNumber: order.number,
            gameNameAr: names?.gameNameAr ?? '',
            productNameAr: names?.productNameAr ?? '',
            quantity: attempt.quantity,
            waitMinutes: Math.floor((now.getTime() - attempt.sentAt.getTime()) / 60_000),
          },
          dedupeKey: `manual-reminder:${attempt.id}`,
        });
        return true;
      });
      if (done) reminded.push(row.attemptId);
    }
    return reminded;
  }

  /** Rule F6: `paid` or `failed` orders with no open attempt, untouched for a minute. */
  private async queueFulfils(db: Executor, late: Date): Promise<string[]> {
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          inArray(orders.status, ['paid', 'failed']),
          lt(orders.updatedAt, late),
          notExists(
            db
              .select({ id: fulfilmentAttempts.id })
              .from(fulfilmentAttempts)
              .where(
                and(
                  eq(fulfilmentAttempts.orderId, orders.id),
                  inArray(fulfilmentAttempts.status, [...OPEN]),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(orders.updatedAt))
      .limit(BATCH);
    if (rows.length === 0) return [];
    await db.transaction(async (tx) => {
      // `stately`: a routing run already queued for an order makes this one a no-op.
      for (const row of rows) await queueFulfil(tx, bossJobSender(this.pgBoss.boss), row.id);
    });
    return rows.map((row) => row.id);
  }
}

async function productName(tx: Transaction, productId: string): Promise<string> {
  const [row] = await tx
    .select({ nameAr: catalogProducts.nameAr })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, productId));
  return row?.nameAr ?? '';
}
