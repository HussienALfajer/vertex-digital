import { Inject, Injectable } from '@nestjs/common';
import {
  PUSH_CHANGES_PER_HOUR,
  PUSH_SUBSCRIPTIONS_MAX,
  type PushConfig,
  type PushSubscription,
  pushEndpointAllowed,
  vapidKeyId,
} from '@vertex-digital/contracts';
import { type Database, newId, pushSubscriptions, withinLimits } from '@vertex-digital/db';
import { and, eq, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';

const HOUR = 60 * 60 * 1000;

/**
 * Web push devices (S15 rules PS1–PS8): a device registers the browser's subscription for the
 * signed-in session and removes its own. The API never calls a push service; the worker sends.
 */
@Injectable()
export class PushService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Push is configured when the API has the public key (S15 environment). */
  config(): PushConfig {
    return { publicKey: this.env.VAPID_PUBLIC_KEY ?? null };
  }

  /**
   * Rule PS1: an upsert by endpoint, moving an existing row to this customer and session with
   * the new keys (edge case 5); rule PS3: the customer's 11th device removes the one with the
   * oldest `updated_at`, in the same transaction, under the customer's lock.
   */
  async register(
    customer: { id: string; sessionId: string },
    subscription: PushSubscription,
  ): Promise<void> {
    const publicKey = this.env.VAPID_PUBLIC_KEY;
    if (!publicKey) {
      throw new CodedException(409, 'PUSH_NOT_CONFIGURED', 'Web push is not configured');
    }
    if (!pushEndpointAllowed(subscription.endpoint)) {
      throw new CodedException(400, 'PUSH_ENDPOINT_REFUSED', 'Not an allowed push service');
    }
    await this.limit(customer.id);
    const keys = {
      customerId: customer.id,
      sessionId: customer.sessionId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      vapidKeyId: vapidKeyId(publicKey),
    };
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`push:${customer.id}`}, 0))`,
      );
      await tx
        .insert(pushSubscriptions)
        .values({ id: newId(), endpoint: subscription.endpoint, ...keys })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { ...keys, failures: 0, updatedAt: sql`now()` },
        });
      await tx.execute(sql`
        delete from ${pushSubscriptions}
        where ${pushSubscriptions.id} in (
          select ${pushSubscriptions.id} from ${pushSubscriptions}
          where ${pushSubscriptions.customerId} = ${customer.id}
          order by ${pushSubscriptions.updatedAt} desc, ${pushSubscriptions.id} desc
          offset ${PUSH_SUBSCRIPTIONS_MAX}
        )`);
    });
  }

  /** Rule PS8: only the customer's own row; the same answer when nothing matched. */
  async remove(customerId: string, endpoint: string): Promise<void> {
    await this.limit(customerId);
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.customerId, customerId)),
      );
  }

  /** 20 registrations and removals an hour per customer (S15 API). */
  private async limit(customerId: string): Promise<void> {
    const allowed = await withinLimits(this.db, [
      { key: `push:customer:${customerId}`, max: PUSH_CHANGES_PER_HOUR, windowMs: HOUR },
    ]);
    if (!allowed) throw new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');
  }
}
