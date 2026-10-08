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
  customers,
  type Database,
  depositSettings,
  deposits,
  ledgerSummary,
  queueTelegramMessage,
  storeSwitchChanges,
  type Transaction,
  usdtTransferState,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, count, desc, eq, gte, like, sql } from 'drizzle-orm';
import { TelegramAlerts } from '../../core/alerts/telegram-alerts.js';
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
            like(deposits.decisionIdempotencyKey, 'telegram:%'),
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
    };
  }
}
