import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CODE_EMAIL_TEMPLATES, QUEUES } from '@vertex-digital/contracts';
import { type Database, emailOutbox } from '@vertex-digital/db';
import { and, inArray, isNotNull, lte } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const PURGE_CODES_CRON = '*/10 * * * *';

/**
 * `email.purge-codes` (S01 rule E4), every 10 minutes: clears the code of every code email whose
 * code expired, rows the send job never reached included. Safe to run twice.
 */
@Injectable()
export class PurgeCodesJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeCodesJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.emailPurgeCodes, async () => {
      await this.purge();
    });
    await this.pgBoss.boss.schedule(QUEUES.emailPurgeCodes, PURGE_CODES_CRON);
    this.logger.log(`Scheduled ${QUEUES.emailPurgeCodes} (${PURGE_CODES_CRON})`);
  }

  /** Clears expired codes; returns how many rows it changed. */
  async purge(now = new Date()): Promise<number> {
    const cleared = await this.db
      .update(emailOutbox)
      .set({ params: null })
      .where(
        and(
          inArray(emailOutbox.template, [...CODE_EMAIL_TEMPLATES]),
          isNotNull(emailOutbox.params),
          lte(emailOutbox.expiresAt, now),
        ),
      )
      .returning({ id: emailOutbox.id });
    return cleared.length;
  }
}
