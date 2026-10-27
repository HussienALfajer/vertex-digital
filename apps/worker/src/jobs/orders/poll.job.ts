import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  isOpenAttempt,
  type OrdersPollPayload,
  ordersPollPayloadSchema,
  QUEUES,
} from '@vertex-digital/contracts';
import {
  type AppliedOutcome,
  type AttemptRow,
  applyOutcome,
  type Database,
  fulfilmentAttempts,
  lockOrder,
  orderCodesKey,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';
import {
  applyQuotedCost,
  askSupplier,
  checkCharge,
  markStockRefusal,
  markSubscriptionRefusal,
  orderContext,
  type QuoteCheck,
  quoteBeforeSend,
  reportLateResult,
  retryOnDeadlock,
  routingContext,
} from './order-calls.js';

type Executor = Database | Transaction;

/**
 * `orders.poll` (S08 rule F3), one job per attempt (`stately`), queued with `startAfter` at its
 * `next_poll_at`: a `pending` attempt is read with `getOrder`; a `sending` or `unknown` one is
 * sent again with the same key (the supplier may never have received it, ADR 0004; a rerouted
 * attempt not yet sent is sent for the first time, S16 rule RS1), and the
 * answer applied by rule F1 (`resolvedBy = poll`), which schedules the next poll by rule F7. The
 * supplier stays the attempt's, even when it is down or paused since (rule F8). Manual attempts
 * are never polled (rule MN2).
 */
@Injectable()
export class OrdersPollJob implements OnApplicationBootstrap {
  private readonly codesKey: Buffer;

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly registry: SupplierRegistry,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<OrdersPollPayload>(QUEUES.ordersPoll, async (data) => {
      await this.poll(ordersPollPayloadSchema.parse(data).attemptId);
    });
  }

  /** The applied result, or null when there was nothing to poll. */
  async poll(attemptId: string, db: Executor = this.db): Promise<AppliedOutcome | null> {
    const [row] = await db
      .select({ attempt: fulfilmentAttempts, supplierCode: suppliers.code })
      .from(fulfilmentAttempts)
      .innerJoin(suppliers, eq(suppliers.id, fulfilmentAttempts.supplierId))
      .where(eq(fulfilmentAttempts.id, attemptId));
    if (!row || row.supplierCode === 'manual' || !isOpenAttempt(row.attempt.status)) return null;
    const { attempt } = row;
    const call = await this.call(db, attempt);
    // Closed since it was read (the admin, a webhook): nothing is sent for it (audit A04-26).
    if (call === null || !(await this.stillOpen(db, attempt.id))) return null;
    // S18 PQ1: a rerouted attempt's first send is quoted too.
    const quote: QuoteCheck =
      call === 'place' ? await quoteBeforeSend(db, this.registry, attempt) : {};
    const outcome = quote.refusal ?? (await askSupplier(db, this.registry, attempt, call));
    // One transaction, run again if a deadlock picks it (audit A04-4, as the fulfil).
    return retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // The order lock first, as `applyOutcome` takes it: then the count, on an open attempt.
        await lockOrder(tx, attempt.orderId);
        await tx
          .update(fulfilmentAttempts)
          .set({ pollCount: sql`${fulfilmentAttempts.pollCount} + 1` })
          .where(
            and(
              eq(fulfilmentAttempts.id, attemptId),
              inArray(fulfilmentAttempts.status, ['sending', 'pending', 'unknown']),
            ),
          );
        const context = orderContext(this.pgBoss, this.codesKey);
        const applied = await applyOutcome(tx, context, attemptId, outcome, { by: 'poll' });
        // Closed meanwhile (a webhook, the admin): a different answer is a conflict (rule F5).
        if (!applied.applied)
          await reportLateResult(tx, context, applied, outcome, { kind: 'poll' });
        // S17 WR8: only a rerouted attempt's first send (S16 RS1) is a refusal for stock; a status
        // read or a re-send never marks the offer.
        const routing = routingContext(this.env);
        if (call === 'place') {
          await markStockRefusal(tx, applied, outcome, { ...routing, jobs: context.jobs });
          await markSubscriptionRefusal(tx, applied, outcome, { ...routing, jobs: context.jobs });
        }
        await applyQuotedCost(tx, applied.attempt, quote, routing);
        if (applied.applied) await checkCharge(tx, applied, { ...routing, jobs: context.jobs });
        return applied;
      }),
    );
  }

  /**
   * S16 rule RS1: a rerouted `sending` attempt whose first send never started is marked before the
   * call, committed, and sent as a first send, whose refusal fails it; one marked already, any
   * other unmarked one, or `unknown`, is a re-send. The mark is claimed by one poll only.
   */
  private async call(
    db: Executor,
    attempt: AttemptRow,
  ): Promise<'place' | 'resend' | 'get' | null> {
    if (attempt.status === 'pending') return 'get';
    // Only a reroute leaves the mark empty; any other unmarked attempt (one an older release wrote
    // during a deploy) may have been sent, so it is re-sent.
    if (attempt.status !== 'sending' || attempt.sendStartedAt !== null || !attempt.chosenByAdmin)
      return 'resend';
    const marked = await db
      .update(fulfilmentAttempts)
      .set({ sendStartedAt: new Date() })
      .where(
        and(
          eq(fulfilmentAttempts.id, attempt.id),
          eq(fulfilmentAttempts.status, 'sending'),
          isNull(fulfilmentAttempts.sendStartedAt),
        ),
      )
      .returning({ id: fulfilmentAttempts.id });
    if (marked.length > 0) return 'place';
    // Another poll claimed the mark (its send is a re-send now), or the attempt closed: then none.
    return (await this.stillOpen(db, attempt.id)) ? 'resend' : null;
  }

  private async stillOpen(db: Executor, attemptId: string): Promise<boolean> {
    const [row] = await db
      .select({ status: fulfilmentAttempts.status })
      .from(fulfilmentAttempts)
      .where(eq(fulfilmentAttempts.id, attemptId));
    return row !== undefined && isOpenAttempt(row.status);
  }
}
