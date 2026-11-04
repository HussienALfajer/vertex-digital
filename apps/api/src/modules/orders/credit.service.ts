import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminOrder,
  CashApprovalInput,
  CreditLimits,
  CreditPolicy,
} from '@vertex-digital/contracts';
import {
  adminOrder,
  creditLimitsFor,
  creditPolicy,
  currentCreditPolicy,
  type Database,
  decideCashHold,
  newId,
  recordAudit,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { JobsService } from '../../core/jobs/index.js';
import type { DecisionActor } from './order-decisions.service.js';
import { asCodedException, orderRefusals } from './order-errors.js';

/**
 * The credit section (S25, ADR 0039): the customer's remaining limits, the credit policy and the
 * admin's decision on a held cash order. The limits and the hold live in `packages/db`'s order
 * write path.
 */
@Injectable()
export class CreditService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/credit-limits`. */
  limits(customerId: string): Promise<CreditLimits> {
    return creditLimitsFor(this.db, customerId);
  }

  policy(): Promise<CreditPolicy> {
    return currentCreditPolicy(this.db);
  }

  /** `PUT /api/admin/credit-policy`: a new row, the newest in force, audited with the one before. */
  setPolicy(actor: DecisionActor, policy: CreditPolicy): Promise<CreditPolicy> {
    return this.db.transaction(async (tx) => {
      const before = await currentCreditPolicy(tx);
      const id = newId();
      await tx.insert(creditPolicy).values({ id, ...policy, adminId: actor.adminId });
      await recordAudit(tx, {
        action: 'credit_policy.set',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'credit_policy',
        entityId: id,
        details: { before, after: policy },
        ...actor.meta,
      });
      return policy;
    });
  }

  /** CS4: approve (fulfilment queued) or reject (refunded) a held cash order, from the panel. */
  async decide(
    actor: DecisionActor,
    orderId: string,
    input: CashApprovalInput,
  ): Promise<AdminOrder> {
    try {
      await this.db.transaction((tx) =>
        decideCashHold(
          tx,
          { jobs: this.jobs },
          {
            orderId,
            decision: input.decision,
            ...(input.reason && { reason: input.reason }),
            by: { kind: 'admin', adminId: actor.adminId, channel: 'admin', ...actor.meta },
          },
        ),
      );
    } catch (error) {
      throw asCodedException(error);
    }
    const order = await adminOrder(this.db, orderId);
    if (!order) throw orderRefusals.notFound();
    return order;
  }
}
