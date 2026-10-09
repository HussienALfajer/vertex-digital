import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type DepositMethod,
  QUEUES,
  REVIEW_TIME_ZONE,
  reviewWaitStart,
  STORE_SWITCH_DEFAULTS,
  type StoreSwitch,
  type TelegramMessageParams,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  checkouts,
  customers,
  type Database,
  depositSettings,
  deposits,
  fulfilmentAttempts,
  ledgerSummary,
  orders,
  priceReviews,
  productRoutingStates,
  queueTelegramMessage,
  storeSwitchChanges,
  supplierCalls,
  supplierStates,
  suppliers,
  type Transaction,
  telegramPrompts,
  usdtTransferState,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, count, desc, eq, gte, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { TelegramAlerts } from '../../core/alerts/telegram-alerts.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { waitingDeposits } from './review-reminder.job.js';

/** 22:30 in Damascus (rule AL3). */
export const DAILY_SUMMARY_CRON = '30 22 * * *';

/** The unmatched transfers the panel lists as open: those of the last 30 days (S04 rule U13). */
const UNMATCHED_OPEN_DAYS = 30;

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: REVIEW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Damascus calendar date of `at`, `YYYY-MM-DD`. */
export const damascusDate = (at: Date) => dateFormat.format(at);

/**
 * `telegram.daily-summary` (S05 rule AL3), at 22:30 `Asia/Damascus`: the Damascus calendar day so
 * far, one message per day through its `dedupe_key` `summary:<date>`, so a second run sends
 * nothing (edge case 17). Test customers stay out of the counts (S01).
 */
@Injectable()
export class DailySummaryJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(DailySummaryJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly alerts: TelegramAlerts,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.telegramDailySummary, async () => {
      if (await this.summarize()) this.logger.log('Queued the daily summary');
    });
    await this.pgBoss.boss.schedule(QUEUES.telegramDailySummary, DAILY_SUMMARY_CRON, undefined, {
      tz: REVIEW_TIME_ZONE,
    });
    this.logger.log(`Scheduled ${QUEUES.telegramDailySummary} (${DAILY_SUMMARY_CRON} Damascus)`);
  }

  /** True when the day's summary was queued, false when it already was. */
  async summarize(now = new Date(), db: Database | Transaction = this.db): Promise<boolean> {
    const date = damascusDate(now);
    const params = await this.contents(db, now, date);
    return db.transaction(
      async (tx) =>
        (await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
          kind: 'daily_summary',
          params,
          dedupeKey: `summary:${date}`,
        })) !== null,
    );
  }

  /** What the summary says (rule AL3); `now` and the day come from the caller. */
  async contents(
    db: Database | Transaction,
    now: Date,
    date: string,
  ): Promise<TelegramMessageParams<'daily_summary'>> {
    // Midnight in Damascus, as an instant.
    const dayStart = sql`(${date}::date::timestamp at time zone ${REVIEW_TIME_ZONE})`;
    const realCustomer = sql`not exists (select 1 from ${customers}
      where ${customers.id} = ${deposits.customerId} and ${customers.isTest})`;
    const [
      credited,
      [fromTelegram],
      [rejected],
      [expired],
      waiting,
      [unmatchedToday],
      [unmatchedOpen],
      [newCustomers],
      summary,
      switches,
      [settings],
    ] = await Promise.all([
      db
        .select({
          method: deposits.method,
          count: count(),
          usdUnits: sql<string>`coalesce(sum(${deposits.creditedUsdUnits}), 0)::text`,
        })
        .from(deposits)
        .where(
          and(eq(deposits.status, 'credited'), gte(deposits.decidedAt, dayStart), realCustomer),
        )
        .groupBy(deposits.method)
        .orderBy(deposits.method),
      db
        .select({ count: count() })
        .from(deposits)
        .where(
          and(
            eq(deposits.status, 'credited'),
            gte(deposits.decidedAt, dayStart),
            // A decision from Telegram is keyed by its prompt's id (S05 rule TC4).
            sql`exists (select 1 from ${telegramPrompts} where ${telegramPrompts.id} = ${deposits.decisionIdempotencyKey})`,
            realCustomer,
          ),
        ),
      db
        .select({ count: count() })
        .from(deposits)
        .where(
          and(eq(deposits.status, 'rejected'), gte(deposits.decidedAt, dayStart), realCustomer),
        ),
      db
        .select({ count: count() })
        .from(deposits)
        .where(
          and(eq(deposits.status, 'expired'), gte(deposits.updatedAt, dayStart), realCustomer),
        ),
      waitingDeposits(db),
      db
        .select({ count: count() })
        .from(usdtTransfers)
        .where(and(gte(usdtTransfers.createdAt, dayStart), eq(usdtTransferState, 'unmatched'))),
      db
        .select({ count: count() })
        .from(usdtTransfers)
        .where(
          and(
            sql`${usdtTransfers.createdAt} > now() - make_interval(days => ${UNMATCHED_OPEN_DAYS})`,
            eq(usdtTransferState, 'unmatched'),
          ),
        ),
      db
        .select({ count: count() })
        .from(customers)
        .where(and(gte(customers.createdAt, dayStart), eq(customers.isTest, false))),
      ledgerSummary(db),
      db
        .selectDistinctOn([storeSwitchChanges.switch])
        .from(storeSwitchChanges)
        .orderBy(
          storeSwitchChanges.switch,
          desc(storeSwitchChanges.createdAt),
          desc(storeSwitchChanges.id),
        ),
      db
        .select()
        .from(depositSettings)
        .orderBy(desc(depositSettings.createdAt), desc(depositSettings.id))
        .limit(1),
    ]);
    const hours = settings && {
      start: settings.reviewHoursStart.slice(0, 5),
      end: settings.reviewHoursEnd.slice(0, 5),
    };
    const oldest = waiting[0];
    const values = { ...STORE_SWITCH_DEFAULTS };
    for (const row of switches) values[row.switch] = row.value;
    const since = new Map(switches.map((row) => [row.switch, row.createdAt]));
    const active = (Object.keys(values) as StoreSwitch[]).filter(
      (name) => name !== 'registration_open' && values[name],
    );
    return {
      date,
      credited: credited.map((row) => ({
        method: row.method as DepositMethod,
        count: row.count,
        usdUnits: Number(row.usdUnits),
      })),
      approvedFromTelegram: fromTelegram?.count ?? 0,
      rejected: rejected?.count ?? 0,
      expired: expired?.count ?? 0,
      waiting: waiting.length,
      oldestWaitMinutes:
        oldest && hours
          ? Math.max(
              0,
              Math.floor(
                (now.getTime() - reviewWaitStart(oldest.submittedAt, hours).getTime()) / 60_000,
              ),
            )
          : null,
      unmatchedToday: unmatchedToday?.count ?? 0,
      unmatchedOpen: unmatchedOpen?.count ?? 0,
      newCustomers: newCustomers?.count ?? 0,
      walletsTotalUsdUnits: summary.owedToCustomersUnits,
      registrationOpen: values.registration_open,
      activeSwitches: active.map((name) => ({
        switch: name,
        since: (since.get(name) ?? now).toISOString(),
      })),
      suppressedAlerts: this.alerts.suppressedOn(date),
      ...(await this.supplierLines(db, now)),
      ...(await this.orderLines(db, dayStart)),
      ...(await this.reservationLines(db, dayStart)),
      ...(await this.checkoutLines(db, dayStart)),
    };
  }

  /** S10: real customers' checkouts paid today, and how many orders they made. */
  private async checkoutLines(db: Database | Transaction, dayStart: SQL) {
    const [row] = await db
      .select({
        checkouts: count(),
        orders: sql<number>`coalesce(sum(${checkouts.lineCount}), 0)`.mapWith(Number),
      })
      .from(checkouts)
      .where(and(eq(checkouts.isTest, false), gte(checkouts.createdAt, dayStart)));
    return { checkouts: row?.checkouts ?? 0, checkoutOrders: row?.orders ?? 0 };
  }

  /**
   * S09: today's player checks per supplier (all of them count toward its quota, rule PV5), and
   * real customers' reservations paid (A02) and expired (A15) today.
   */
  private async reservationLines(db: Database | Transaction, dayStart: SQL) {
    const real = eq(orders.isTest, false);
    const [validations, [paid], [expired]] = await Promise.all([
      db
        .select({ supplierNameAr: suppliers.nameAr, count: count() })
        .from(supplierCalls)
        .innerJoin(suppliers, eq(suppliers.id, supplierCalls.supplierId))
        .where(
          and(
            eq(supplierCalls.operation, 'validate_player'),
            gte(supplierCalls.createdAt, dayStart),
          ),
        )
        .groupBy(suppliers.nameAr)
        .orderBy(suppliers.nameAr),
      db
        .select({ count: count() })
        .from(orders)
        .where(and(real, isNotNull(orders.reservedAt), gte(orders.paidAt, dayStart))),
      db
        .select({ count: count() })
        .from(orders)
        .where(
          and(
            real,
            eq(orders.status, 'cancelled'),
            eq(orders.cancelReason, 'expired'),
            gte(orders.finishedAt, dayStart),
          ),
        ),
    ]);
    return {
      validations,
      reservationsPaid: paid?.count ?? 0,
      reservationsExpired: expired?.count ?? 0,
    };
  }

  /**
   * S08: real customers' orders that ended today by how they ended, and the median delivery time
   * of today's deliveries; the orders held for review and the manual attempts waiting, now.
   */
  private async orderLines(db: Database | Transaction, dayStart: SQL) {
    const endedToday = and(eq(orders.isTest, false), gte(orders.finishedAt, dayStart));
    const [ended, [review], [manual], [median]] = await Promise.all([
      db
        .select({ status: orders.status, count: count() })
        .from(orders)
        .where(
          and(endedToday, inArray(orders.status, ['delivered', 'partially_refunded', 'refunded'])),
        )
        .groupBy(orders.status),
      db.select({ count: count() }).from(orders).where(eq(orders.status, 'needs_review')),
      db
        .select({ count: count() })
        .from(fulfilmentAttempts)
        .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
        .where(
          and(
            eq(suppliers.code, 'manual'),
            inArray(fulfilmentAttempts.status, ['sending', 'pending', 'unknown']),
          ),
        ),
      db
        .select({
          ms: sql<string | null>`(percentile_disc(0.5) within group (order by
            extract(epoch from ${orders.deliveredAt} - ${orders.paidAt}) * 1000))::bigint::text`,
        })
        .from(orders)
        .where(and(endedToday, eq(orders.status, 'delivered'))),
    ]);
    const ofStatus = (status: string) => ended.find((row) => row.status === status)?.count ?? 0;
    return {
      ordersDelivered: ofStatus('delivered'),
      ordersPartiallyRefunded: ofStatus('partially_refunded'),
      ordersRefunded: ofStatus('refunded'),
      ordersInReview: review?.count ?? 0,
      manualWaiting: manual?.count ?? 0,
      medianDeliveryMs: median?.ms == null ? null : Math.max(0, Number(median.ms)),
    };
  }

  /**
   * S07: the open reviews, the products the margin guard holds (only while a review holds their
   * price, rule P6), and the suppliers in use that are not healthy or whose balance is low (H5).
   */
  private async supplierLines(db: Database | Transaction, now: Date) {
    const context = { now, fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED };
    const [open, states] = await Promise.all([
      db
        .select({ productId: priceReviews.productId })
        .from(priceReviews)
        .where(eq(priceReviews.status, 'open')),
      supplierStates(db, context),
    ]);
    const routing = await productRoutingStates(
      db,
      open.map((row) => row.productId),
      context,
    );
    const inUse = states.filter((state) => state.available && state.code !== 'manual');
    return {
      openReviews: open.length,
      marginGuarded: [...routing.values()].filter(
        (state) => state.availability === 'paused_by_margin_guard',
      ).length,
      suppliersNotHealthy: inUse
        .filter((state) => state.health !== 'healthy')
        .map((state) => ({ supplierNameAr: state.nameAr, state: state.health })),
      balancesLow: inUse.flatMap((state) =>
        state.balance?.currency === 'USD' && state.balance.amountUnits < state.lowBalanceUsdUnits
          ? [
              {
                supplierNameAr: state.nameAr,
                currency: state.balance.currency,
                amountUnits: state.balance.amountUnits,
              },
            ]
          : [],
      ),
    };
  }
}
