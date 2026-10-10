import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { autoCloseBefore, QUEUES } from '@vertex-digital/contracts';
import { type Database, recordAudit, supportTickets } from '@vertex-digital/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const AUTO_CLOSE_CRON = '7 * * * *';

/** Tickets closed per transaction. */
export const AUTO_CLOSE_BATCH_SIZE = 100;

/**
 * `support.auto-close` (S12 TK6), every hour: closes `answered` tickets whose last admin message
 * is older than 7 days, by the system, in batches of 100 locked with `FOR UPDATE SKIP LOCKED`, one
 * audit entry each. A customer writing right now holds the ticket's lock and is skipped, then
 * reopens it anyway (edge case 15). Safe to run twice: only `answered` tickets are taken. No
 * notification: the thread shows that it closed for lack of an answer.
 */
@Injectable()
export class SupportAutoCloseJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupportAutoCloseJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.supportAutoClose, async () => {
      const closed = await this.close(new Date());
      if (closed > 0) this.logger.log(`Closed ${closed} unanswered tickets`);
    });
    await this.pgBoss.boss.schedule(QUEUES.supportAutoClose, AUTO_CLOSE_CRON);
    this.logger.log(`Scheduled ${QUEUES.supportAutoClose} (${AUTO_CLOSE_CRON})`);
  }

  /** Closes every due ticket it can lock; returns how many. */
  async close(now: Date): Promise<number> {
    const before = autoCloseBefore(now);
    let total = 0;
    for (;;) {
      const closed = await this.db.transaction(async (tx) => {
        const due = await tx
          .select({ id: supportTickets.id, category: supportTickets.category })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.status, 'answered'),
              lt(supportTickets.lastAdminMessageAt, before),
            ),
          )
          .orderBy(supportTickets.lastAdminMessageAt, supportTickets.id)
          .limit(AUTO_CLOSE_BATCH_SIZE)
          .for('update', { skipLocked: true });
        if (due.length === 0) return 0;
        await tx
          .update(supportTickets)
          .set({
            status: 'closed',
            closedAt: sql`now()`,
            closedBy: 'system',
            updatedAt: sql`now()`,
          })
          .where(
            and(
              inArray(
                supportTickets.id,
                due.map((ticket) => ticket.id),
              ),
              eq(supportTickets.status, 'answered'),
            ),
          );
        for (const ticket of due) {
          await recordAudit(tx, {
            action: 'ticket.closed',
            actorKind: 'system',
            actorId: null,
            channel: 'worker',
            entityType: 'support_ticket',
            entityId: ticket.id,
            details: {
              ticketId: ticket.id,
              category: ticket.category,
              before: 'answered',
              after: 'closed',
              cause: 'auto_close',
            },
          });
        }
        return due.length;
      });
      total += closed;
      if (closed < AUTO_CLOSE_BATCH_SIZE) return total;
    }
  }
}
