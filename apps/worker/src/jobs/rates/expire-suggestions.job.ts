import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, RATE_SUGGESTION_TTL_HOURS } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  endSuggestion,
  lockRates,
  rateSuggestions,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, lt } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const RATES_EXPIRE_SUGGESTIONS_CRON = '7 * * * *';

/**
 * `rates.expire-suggestions` (S27 SG5), hourly: a suggestion pending for 6 hours ends `expired`
 * and its card is edited to say so. Under the rate lock, as every suggestion change; safe to run
 * twice: an ended suggestion is no longer pending.
 */
@Injectable()
export class ExpireRateSuggestionsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExpireRateSuggestionsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.ratesExpireSuggestions, async () => {
      if (await this.expire()) this.logger.log('Expired a pending rate suggestion');
    });
    await this.pgBoss.boss.schedule(QUEUES.ratesExpireSuggestions, RATES_EXPIRE_SUGGESTIONS_CRON);
    this.logger.log(
      `Scheduled ${QUEUES.ratesExpireSuggestions} (${RATES_EXPIRE_SUGGESTIONS_CRON})`,
    );
  }

  /** The pending suggestion older than 6 hours at `now`, ended; true when one was. */
  async expire(now = new Date(), db: Database | Transaction = this.db): Promise<boolean> {
    return db.transaction(async (tx) => {
      await lockRates(tx);
      const due = new Date(now.getTime() - RATE_SUGGESTION_TTL_HOURS * 3_600_000);
      const [row] = await tx
        .select({ id: rateSuggestions.id })
        .from(rateSuggestions)
        .where(and(eq(rateSuggestions.status, 'pending'), lt(rateSuggestions.createdAt, due)))
        .for('update');
      if (!row) return false;
      const ended = await endSuggestion(tx, bossJobSender(this.pgBoss.boss), {
        suggestionId: row.id,
        status: 'expired',
      });
      return ended !== null;
    });
  }
}
