import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { OUTBOX_RETENTION_DAYS, QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import { type Database, emailOutbox, telegramMessages } from '@vertex-digital/db';
import { and, inArray, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const PURGE_OUTBOXES_CRON = '30 4 * * *';

/** Rows cleared per statement. */
export const PURGE_OUTBOXES_BATCH = 1_000;

/**
 * Message kinds whose parameters later messages read (the newest state told per supplier: the
 * health and balance jobs), and which name no customer: never cleared.
 */
const KEPT_TELEGRAM_KINDS = ['supplier_health', 'supplier_balance_low'] as const;

const pastRetention = (column: typeof emailOutbox.updatedAt | typeof telegramMessages.createdAt) =>
  lt(column, sql`now() - make_interval(days => ${OUTBOX_RETENTION_DAYS})`);

/**
 * `system.purge-outboxes` (Q29, audit A10-46), daily at 04:30 Damascus: a settled email keeps its
 * address and parameters, and a settled Telegram message its parameters, `OUTBOX_RETENTION_DAYS`
 * after it was settled, then they are cleared; the rows stay as the delivery record. Code emails
 * are cleared much sooner by `email.purge-codes` (S01 rule E4). In batches; safe to run twice.
 */
@Injectable()
export class PurgeOutboxesJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeOutboxesJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.systemPurgeOutboxes, async () => {
      const { emails, messages } = await this.purge();
      if (emails + messages > 0) {
        this.logger.log(`Cleared ${emails} old emails and ${messages} old Telegram messages`);
      }
    });
    await this.pgBoss.boss.schedule(QUEUES.systemPurgeOutboxes, PURGE_OUTBOXES_CRON, undefined, {
      tz: REVIEW_TIME_ZONE,
    });
    this.logger.log(`Scheduled ${QUEUES.systemPurgeOutboxes} (${PURGE_OUTBOXES_CRON} Damascus)`);
  }

  /** Clears every settled row past the retention; how many of each. */
  async purge(): Promise<{ emails: number; messages: number }> {
    let emails = 0;
    for (;;) {
      const batch = this.db
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(
            inArray(emailOutbox.status, ['sent', 'failed']),
            or(isNotNull(emailOutbox.toAddress), isNotNull(emailOutbox.params)),
            pastRetention(emailOutbox.updatedAt),
          ),
        )
        .limit(PURGE_OUTBOXES_BATCH);
      const cleared = await this.db
        .update(emailOutbox)
        .set({ toAddress: null, params: null })
        .where(inArray(emailOutbox.id, batch))
        .returning({ id: emailOutbox.id });
      emails += cleared.length;
      if (cleared.length < PURGE_OUTBOXES_BATCH) break;
    }
    let messages = 0;
    for (;;) {
      const batch = this.db
        .select({ id: telegramMessages.id })
        .from(telegramMessages)
        .where(
          and(
            inArray(telegramMessages.status, ['sent', 'failed', 'skipped']),
            notInArray(telegramMessages.kind, [...KEPT_TELEGRAM_KINDS]),
            sql`${telegramMessages.params} <> '{}'::jsonb`,
            pastRetention(telegramMessages.createdAt),
          ),
        )
        .limit(PURGE_OUTBOXES_BATCH);
      const cleared = await this.db
        .update(telegramMessages)
        .set({ params: {} })
        .where(inArray(telegramMessages.id, batch))
        .returning({ id: telegramMessages.id });
      messages += cleared.length;
      if (cleared.length < PURGE_OUTBOXES_BATCH) break;
    }
    return { emails, messages };
  }
}
