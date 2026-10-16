import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import { bossJobSender, type Database, expireDueDeposits } from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const EXPIRE_DEPOSITS_CRON = '*/5 * * * *';

/** Deposits expired per transaction. */
export const EXPIRE_BATCH_SIZE = 100;

/**
 * `deposits.expire` (S03 rule SC12), every 5 minutes: moves `pending` deposits past `expires_at`
 * to `expired` through `expireDueDeposits` (`packages/db`), in batches of 100 locked with
 * `FOR UPDATE SKIP LOCKED`, one audit entry each, in the batch's transaction. A deposit a
 * customer is submitting right now is locked, so it is skipped; whichever commits first wins
 * (rule SC12). Safe to run twice: the status check makes a second run a no-op. No email: the
 * customer did nothing after creating the deposit.
 */
@Injectable()
export class ExpireDepositsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExpireDepositsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.depositsExpire, async () => {
      const expired = await this.expire();
      if (expired > 0) this.logger.log(`Expired ${expired} deposits`);
    });
    await this.pgBoss.boss.schedule(QUEUES.depositsExpire, EXPIRE_DEPOSITS_CRON);
    this.logger.log(`Scheduled ${QUEUES.depositsExpire} (${EXPIRE_DEPOSITS_CRON})`);
  }

  /** Expires every overdue deposit it can lock; returns how many. */
  async expire(): Promise<number> {
    let total = 0;
    for (;;) {
      const expired = await this.db.transaction((tx) =>
        expireDueDeposits(tx, bossJobSender(this.pgBoss.boss), {
          limit: EXPIRE_BATCH_SIZE,
          channel: 'worker',
        }),
      );
      total += expired;
      if (expired < EXPIRE_BATCH_SIZE) return total;
    }
  }
}
