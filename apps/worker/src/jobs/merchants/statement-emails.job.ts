import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { damascusMonth, previousMonth, QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  sendStatementReady,
  statementEmailMerchants,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** ST4: the 1st at 08:00 `Asia/Damascus`. */
export const STATEMENT_EMAILS_CRON = '0 8 1 * *';

/**
 * `merchants.statement-emails` (S21 ST4), monthly: `merchant_statement_ready` with a link to last
 * month's statement for every merchant with at least one wallet entry that month, each in a
 * transaction of their own. Safe twice: a month's notification already written is not written
 * again (`sendStatementReady`, the dedupe key `statement:<customer>:<month>`).
 */
@Injectable()
export class MerchantStatementEmailsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(MerchantStatementEmailsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.merchantsStatementEmails, async () => {
      const sent = await this.sendAll(new Date());
      if (sent > 0) this.logger.log(`Told ${sent} merchants their statement is ready`);
    });
    await this.pgBoss.boss.schedule(
      QUEUES.merchantsStatementEmails,
      STATEMENT_EMAILS_CRON,
      {},
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(
      `Scheduled ${QUEUES.merchantsStatementEmails} (${STATEMENT_EMAILS_CRON} Damascus)`,
    );
  }

  /** ST4: last month's notifications at `now`; returns how many were written. */
  async sendAll(now: Date): Promise<number> {
    const month = previousMonth(damascusMonth(now));
    const jobs = bossJobSender(this.pgBoss.boss);
    let sent = 0;
    for (const customerId of await statementEmailMerchants(this.db, month)) {
      if (await this.db.transaction((tx) => sendStatementReady(tx, jobs, customerId, month))) {
        sent += 1;
      }
    }
    return sent;
  }
}
