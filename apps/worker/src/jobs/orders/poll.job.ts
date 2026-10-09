import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  isOpenAttempt,
  type OrdersPollPayload,
  ordersPollPayloadSchema,
  QUEUES,
} from '@vertex-digital/contracts';
import {
  type AppliedOutcome,
  applyOutcome,
  type Database,
  fulfilmentAttempts,
  lockOrder,
  orderCodesKey,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';
import { askSupplier, orderContext } from './order-calls.js';

type Executor = Database | Transaction;

/**
 * `orders.poll` (S08 rule F3), one job per attempt (`stately`), queued with `startAfter` at its
 * `next_poll_at`: a `pending` attempt is read with `getOrder`; a `sending` or `unknown` one is
 * sent again with the same key (the supplier may never have received it, ADR 0004), and the
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
    @Inject(ENV) env: Env,
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
    const outcome = await askSupplier(
      db,
      this.registry,
      attempt,
      attempt.status === 'pending' ? 'get' : 'place',
    );
    return db.transaction(async (tx) => {
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
      return applyOutcome(tx, orderContext(this.pgBoss, this.codesKey), attemptId, outcome, {
        by: 'poll',
      });
    });
  }
}
