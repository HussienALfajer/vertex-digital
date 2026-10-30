import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  overdueTickets,
  tellTicketOverdue,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** OP6: every 15 minutes. */
export const OVERDUE_TICKETS_CRON = '*/15 * * * *';

/**
 * `support.overdue-tickets` (S23 OP6), every 15 minutes: each open ticket of a merchant whose tier
 * promises a reply, waiting past the promise, tells the admin on Telegram once per waiting period
 * (dedupe key `ticket-overdue:<ticket>:<last customer message>`), one transaction per ticket.
 * Safe twice: a told period writes nothing new; a failing ticket does not stop the others, and the
 * run then fails naming how many.
 */
@Injectable()
export class SupportOverdueTicketsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupportOverdueTicketsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.supportOverdueTickets, async () => {
      const told = await this.run(new Date());
      if (told > 0) this.logger.log(`Told the admin of ${told} overdue tickets`);
    });
    await this.pgBoss.boss.schedule(QUEUES.supportOverdueTickets, OVERDUE_TICKETS_CRON);
    this.logger.log(`Scheduled ${QUEUES.supportOverdueTickets} (${OVERDUE_TICKETS_CRON})`);
  }

  /** Returns how many tickets were told now. */
  async run(now: Date): Promise<number> {
    const jobs = bossJobSender(this.pgBoss.boss);
    let told = 0;
    let failed = 0;
    for (const ticket of await overdueTickets(this.db, now)) {
      try {
        if (await this.db.transaction((tx) => tellTicketOverdue(tx, jobs, ticket, now))) told += 1;
      } catch (error) {
        const reported = withoutQueryParameters(error) as Error;
        this.logger.error(`Overdue ticket ${ticket.ticketId} failed: ${reported.message}`);
        failed += 1;
      }
    }
    if (failed > 0) throw new Error(`Overdue tickets failed for ${failed} tickets`);
    return told;
  }
}
