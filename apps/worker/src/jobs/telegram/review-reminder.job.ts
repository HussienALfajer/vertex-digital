import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  overdueReviews,
  QUEUES,
  reviewReminderDue,
  TELEGRAM_REMINDER_MAX_LINES,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  depositSettings,
  deposits,
  queueTelegramMessage,
  type Transaction,
  telegramBotState,
  telegramDepositCards,
  telegramPrompts,
  telegramUpdates,
  usdtDeposits,
} from '@vertex-digital/db';
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const REVIEW_REMINDER_CRON = '*/5 * * * *';

/** Handled update ids are kept a week (rule TG5): a redelivery comes within minutes. */
const UPDATES_KEPT_DAYS = 7;

/** What waits for the admin (rule RM2), with its card's `reminded_at`. */
export interface WaitingDeposit {
  id: string;
  referenceCode: string;
  submittedAt: Date;
  remindedAt: Date | null;
}

/**
 * Sham Cash deposits `submitted` and USDT deposits in review, oldest first, each with the
 * `reminded_at` of its current card (rule RM2). Shared with the daily summary.
 */
export async function waitingDeposits(db: Database | Transaction): Promise<WaitingDeposit[]> {
  const rows = await db
    .select({
      id: deposits.id,
      referenceCode: deposits.referenceCode,
      submittedAt: deposits.submittedAt,
      remindedAt: telegramDepositCards.remindedAt,
    })
    .from(deposits)
    .leftJoin(usdtDeposits, eq(usdtDeposits.depositId, deposits.id))
    .leftJoin(
      telegramDepositCards,
      and(
        eq(telegramDepositCards.depositId, deposits.id),
        eq(telegramDepositCards.submittedAt, deposits.submittedAt),
      ),
    )
    .where(
      and(
        eq(deposits.status, 'submitted'),
        or(eq(deposits.method, 'sham_cash'), eq(usdtDeposits.checkStatus, 'review')),
      ),
    )
    .orderBy(deposits.submittedAt, deposits.id);
  return rows.flatMap((row) => (row.submittedAt ? [{ ...row, submittedAt: row.submittedAt }] : []));
}

/**
 * `telegram.review-reminder` (S05 rules RM1–RM4), every 5 minutes: within the review hours, one
 * grouped message of the overdue reviews when one was never listed, or every 30 minutes while
 * some remain. The message, the cards' `reminded_at` and `last_reminder_at` commit together, with
 * the bot state row locked, so a restart neither skips nor repeats (edge case 18). It also prunes
 * the handled update ids older than 7 days and closes expired prompts.
 */
@Injectable()
export class ReviewReminderJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReviewReminderJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.telegramReviewReminder, async () => {
      const sent = await this.remind();
      if (sent) this.logger.log('Sent a review reminder');
    });
    await this.pgBoss.boss.schedule(QUEUES.telegramReviewReminder, REVIEW_REMINDER_CRON);
    this.logger.log(`Scheduled ${QUEUES.telegramReviewReminder} (${REVIEW_REMINDER_CRON})`);
  }

  /** True when a reminder was queued. `now` is a parameter for tests (edge case 20). */
  async remind(now = new Date(), db: Database | Transaction = this.db): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.insert(telegramBotState).values({ id: 1 }).onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(telegramBotState)
        .where(eq(telegramBotState.id, 1))
        .for('update');
      await tx
        .delete(telegramUpdates)
        .where(
          lt(
            telegramUpdates.receivedAt,
            sql`${now.toISOString()}::timestamptz - make_interval(days => ${UPDATES_KEPT_DAYS})`,
          ),
        );
      await tx
        .update(telegramPrompts)
        .set({ closedAt: now })
        .where(and(isNull(telegramPrompts.closedAt), lte(telegramPrompts.expiresAt, now)));
      const [settings] = await tx
        .select()
        .from(depositSettings)
        .orderBy(desc(depositSettings.createdAt), desc(depositSettings.id))
        .limit(1);
      if (!settings) return false;
      const hours = {
        start: settings.reviewHoursStart.slice(0, 5),
        end: settings.reviewHoursEnd.slice(0, 5),
      };
      const overdue = overdueReviews(
        await waitingDeposits(tx),
        now,
        hours,
        settings.reviewTargetMinutes,
      );
      const lastReminderAt = state?.lastReminderAt ?? null;
      if (!reviewReminderDue({ now, hours, lastReminderAt, overdue })) return false;
      const listed = overdue.slice(0, TELEGRAM_REMINDER_MAX_LINES);
      await queueTelegramMessage(tx, bossJobSender(this.pgBoss.boss), {
        kind: 'review_reminder',
        params: {
          count: overdue.length,
          oldestWaitMinutes: listed[0]?.waitMinutes ?? 0,
          deposits: listed.map((deposit) => ({
            referenceCode: deposit.referenceCode,
            waitMinutes: deposit.waitMinutes,
          })),
        },
      });
      await tx
        .update(telegramDepositCards)
        .set({ remindedAt: now })
        .where(
          inArray(
            telegramDepositCards.depositId,
            listed.map((deposit) => deposit.id),
          ),
        );
      await tx
        .update(telegramBotState)
        .set({ lastReminderAt: now })
        .where(eq(telegramBotState.id, 1));
      return true;
    });
  }
}
