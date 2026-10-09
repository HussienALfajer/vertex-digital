import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Currency, QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  newId,
  productRoutes,
  queueStoreRevalidate,
  queueTelegramMessage,
  repriceProducts,
  routedProductIds,
  type SupplierState,
  supplierBalanceReads,
  supplierOffers,
  supplierStates,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { recordedCall } from '../../suppliers/supplier-calls.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';

type Executor = Database | Transaction;

/** Every 5 minutes (rule H5). */
export const SUPPLIERS_BALANCES_CRON = '*/5 * * * *';

/** While a balance stays below its threshold, the message repeats every 6 hours (rule H5). */
export const LOW_BALANCE_REPEAT_HOURS = 6;

interface BalanceRead {
  currency: Currency;
  amountUnits: number;
}

/** A USD balance the route rule compares with costs (RT4); another currency limits nothing. */
const usdLimit = (read: BalanceRead | undefined) =>
  read?.currency === 'USD' ? read.amountUnits : Number.POSITIVE_INFINITY;

/**
 * `suppliers.balances` (S07 rule H5), every 5 minutes: each configured, available supplier with
 * the balance capability is read once (the call recorded), the balance appended to
 * `supplier_balance_reads`. When the new balance crosses the cost of a mapped offer, the
 * supplier's products are repriced (RT4). Below the threshold: a message the first time, again
 * every 6 hours, and one when it is back (dedupe keys `balance:<supplier>:<since>[:<n>]`).
 */
@Injectable()
export class SupplierBalancesJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierBalancesJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly registry: SupplierRegistry,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.suppliersBalances, async () => {
      await this.readAll();
    });
    await this.pgBoss.boss.schedule(QUEUES.suppliersBalances, SUPPLIERS_BALANCES_CRON);
    this.logger.log(`Scheduled ${QUEUES.suppliersBalances} (${SUPPLIERS_BALANCES_CRON})`);
  }

  async readAll(db: Executor = this.db, now = new Date()): Promise<void> {
    const states = await supplierStates(db, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED });
    for (const supplier of states) {
      if (supplier.code === 'manual' || !supplier.available || !supplier.configured) continue;
      await this.read(db, supplier, now);
    }
  }

  private async read(db: Executor, supplier: SupplierState, now: Date): Promise<void> {
    let connected: Awaited<ReturnType<SupplierRegistry['connect']>>;
    try {
      connected = await this.registry.connect(db, supplier);
    } catch {
      this.logger.warn(
        `Cannot read the balance of ${supplier.code}: its credentials do not decrypt`,
      );
      return;
    }
    if (!connected?.adapter.capabilities.balance) return;
    const { adapter } = connected;
    const call = await recordedCall(db, supplier.id, 'get_balance', () => adapter.getBalance());
    // A failed read is health's to judge (H1); the last balance stands.
    if (!call.ok || !Number.isSafeInteger(call.value.amountUnits)) return;
    const balance: BalanceRead = call.value;
    await db.transaction(async (tx) => {
      const [previous] = await tx
        .select({
          currency: supplierBalanceReads.currency,
          amountUnits: supplierBalanceReads.amountUnits,
        })
        .from(supplierBalanceReads)
        .where(eq(supplierBalanceReads.supplierId, supplier.id))
        .orderBy(desc(supplierBalanceReads.createdAt), desc(supplierBalanceReads.id))
        .limit(1);
      const [read] = await tx
        .insert(supplierBalanceReads)
        .values({ id: newId(), supplierId: supplier.id, ...balance })
        .returning();
      if (!read) return;
      if (await this.crossesACost(tx, supplier.id, previous, balance)) {
        await repriceProducts(tx, {
          productIds: await routedProductIds(tx, [supplier.code]),
          cause: 'route_change',
          context: { now: new Date(), fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED },
        });
        // S09 rule SF4: routes the balance no longer pays (or pays again) change the store's prices.
        await queueStoreRevalidate(tx, bossJobSender(this.pgBoss.boss));
      }
      await this.notify(tx, supplier, read, previous, now);
    });
  }

  /** The new balance and the previous one stand on two sides of a mapped offer's cost (RT4). */
  private async crossesACost(
    tx: Transaction,
    supplierId: string,
    previous: BalanceRead | undefined,
    balance: BalanceRead,
  ): Promise<boolean> {
    const before = usdLimit(previous);
    const after = usdLimit(balance);
    if (before === after) return false;
    // Not both infinite: they differ.
    const low = Math.min(before, after);
    const high = Math.max(before, after);
    // A cost c is crossed when exactly one balance is at least c: low < c <= high.
    const [row] = await tx
      .select({ id: productRoutes.id })
      .from(productRoutes)
      .innerJoin(supplierOffers, eq(supplierOffers.id, productRoutes.offerId))
      .where(
        and(
          eq(productRoutes.supplierId, supplierId),
          isNull(productRoutes.archivedAt),
          isNotNull(supplierOffers.costUsdUnits),
          gt(supplierOffers.costUsdUnits, low),
          Number.isFinite(high) ? sql`${supplierOffers.costUsdUnits} <= ${high}` : undefined,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Rule H5's messages, each once by its dedupe key. */
  private async notify(
    tx: Transaction,
    supplier: SupplierState,
    read: typeof supplierBalanceReads.$inferSelect,
    previous: BalanceRead | undefined,
    now: Date,
  ): Promise<void> {
    const threshold = supplier.lowBalanceUsdUnits;
    const isLow = (balance: BalanceRead | undefined) =>
      balance?.currency === 'USD' && balance.amountUnits < threshold;
    const nowLow = isLow(read);
    if (!nowLow && !isLow(previous)) return;
    // The low streak's first read: the oldest after the newest read that was not low, before this
    // one (this one included when it is low). Compared in the database: a timestamp read back into
    // JavaScript loses its microseconds.
    const readAt = sql`(select created_at from ${supplierBalanceReads} where id = ${read.id})`;
    const lastOk = sql`(select max(created_at) from ${supplierBalanceReads}
      where supplier_id = ${supplier.id} and created_at < ${readAt}
        and (currency <> 'USD' or amount_units >= ${threshold}))`;
    const [first] = await tx
      .select({ at: supplierBalanceReads.createdAt })
      .from(supplierBalanceReads)
      .where(
        and(
          eq(supplierBalanceReads.supplierId, supplier.id),
          sql`${supplierBalanceReads.createdAt} > coalesce(${lastOk}, '-infinity')`,
          nowLow
            ? sql`${supplierBalanceReads.createdAt} <= ${readAt}`
            : sql`${supplierBalanceReads.createdAt} < ${readAt}`,
        ),
      )
      .orderBy(asc(supplierBalanceReads.createdAt), asc(supplierBalanceReads.id))
      .limit(1);
    const since = first?.at ?? read.createdAt;
    const key = `balance:${supplier.code}:${since.toISOString()}`;
    // `now` was taken before the read: never a negative count.
    const repeat = Math.max(
      0,
      Math.floor((now.getTime() - since.getTime()) / (LOW_BALANCE_REPEAT_HOURS * 3_600_000)),
    );
    await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
      kind: 'supplier_balance_low',
      params: {
        supplier: supplier.code,
        supplierNameAr: supplier.nameAr,
        currency: read.currency,
        amountUnits: read.amountUnits,
        thresholdUsdUnits: threshold,
        recovered: !nowLow,
      },
      dedupeKey: !nowLow ? `${key}:recovered` : repeat === 0 ? key : `${key}:${repeat}`,
    });
  }
}
