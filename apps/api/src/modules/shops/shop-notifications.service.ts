import { createECDH } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type NotificationListQuery,
  PUSH_CHANGES_PER_HOUR,
  PUSH_SUBSCRIPTIONS_MAX,
  type PushSubscription,
  pushEndpointAllowed,
  type ShopCustomerNotification,
  type ShopNotificationPage,
  type UnreadCount,
  vapidKeyId,
} from '@vertex-digital/contracts';
import {
  type Database,
  newId,
  shopCustomerNotifications,
  shopPushSubscriptions,
  withinLimits,
} from '@vertex-digital/db';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import type { ShopCustomerIdentity } from './shop-auth.service.js';

const HOUR = 60 * 60 * 1000;

/**
 * The shop customer's notification center and push devices (S26 PR9, SP1): the customer's own
 * notifications newest first, marked read up to one, and this device's subscription from the
 * shop's service worker. As S15 for Vertex customers: 10 devices, 20 changes an hour, an allowed
 * push service and a P-256 key; the worker sends (`push.send-shop`).
 */
@Injectable()
export class ShopNotificationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `GET /api/shops/:slug/notifications`. */
  async list(
    customer: ShopCustomerIdentity,
    query: NotificationListQuery,
  ): Promise<ShopNotificationPage> {
    const rows = await this.db
      .select({
        row: shopCustomerNotifications,
        cursorAt: cursorTime(shopCustomerNotifications.createdAt),
      })
      .from(shopCustomerNotifications)
      .where(
        and(
          eq(shopCustomerNotifications.shopCustomerId, customer.id),
          query.cursor
            ? after(
                shopCustomerNotifications.createdAt,
                shopCustomerNotifications.id,
                decodeCursor(query.cursor),
              )
            : undefined,
        ),
      )
      .orderBy(desc(shopCustomerNotifications.createdAt), desc(shopCustomerNotifications.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.cursorAt, id: row.row.id }));
    return {
      items: page.items.map(({ row }) => ({
        id: row.id,
        event: row.event,
        params: row.params,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })) as ShopCustomerNotification[],
      nextCursor: page.nextCursor,
      ...(await this.unread(customer)),
    };
  }

  /** `POST /api/shops/:slug/notifications/read`: everything up to this one, included. */
  async markRead(customer: ShopCustomerIdentity, upToId: string): Promise<UnreadCount> {
    const [upTo] = await this.db
      .select({ id: shopCustomerNotifications.id })
      .from(shopCustomerNotifications)
      .where(
        and(
          eq(shopCustomerNotifications.id, upToId),
          eq(shopCustomerNotifications.shopCustomerId, customer.id),
        ),
      );
    if (!upTo) throw new CodedException(404, 'NOT_FOUND', 'No such notification');
    await this.db
      .update(shopCustomerNotifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(shopCustomerNotifications.shopCustomerId, customer.id),
          isNull(shopCustomerNotifications.readAt),
          // The database's own time, microseconds kept: a JS date would miss the row itself.
          sql`${shopCustomerNotifications.createdAt} <= (select created_at
            from shop_customer_notifications where id = ${upToId})`,
        ),
      );
    return this.unread(customer);
  }

  async unread(customer: ShopCustomerIdentity): Promise<UnreadCount> {
    const [row] = await this.db
      .select({ count: count() })
      .from(shopCustomerNotifications)
      .where(
        and(
          eq(shopCustomerNotifications.shopCustomerId, customer.id),
          isNull(shopCustomerNotifications.readAt),
        ),
      );
    return { unreadCount: row?.count ?? 0 };
  }

  /** S15 PS1–PS3 for the shop: an upsert by endpoint; the 11th device removes the oldest. */
  async register(customer: ShopCustomerIdentity, subscription: PushSubscription): Promise<void> {
    const publicKey = this.env.VAPID_PUBLIC_KEY;
    if (!publicKey) {
      throw new CodedException(409, 'PUSH_NOT_CONFIGURED', 'Web push is not configured');
    }
    if (!pushEndpointAllowed(subscription.endpoint)) {
      throw new CodedException(400, 'PUSH_ENDPOINT_REFUSED', 'Not an allowed push service');
    }
    if (!onCurve(subscription.keys.p256dh)) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid input', {
        issues: [{ path: ['keys', 'p256dh'], message: 'Not a P-256 public key' }],
      });
    }
    await this.limit(customer.id);
    const keys = {
      shopCustomerId: customer.id,
      sessionId: customer.sessionId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      vapidKeyId: vapidKeyId(publicKey),
    };
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`shop-push:${customer.id}`}, 0))`,
      );
      await tx
        .insert(shopPushSubscriptions)
        .values({
          id: newId(),
          endpoint: subscription.endpoint,
          ...keys,
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: shopPushSubscriptions.endpoint,
          set: { ...keys, failures: 0, updatedAt: sql`clock_timestamp()` },
        });
      await tx.execute(sql`
        delete from ${shopPushSubscriptions}
        where ${shopPushSubscriptions.id} in (
          select ${shopPushSubscriptions.id} from ${shopPushSubscriptions}
          where ${shopPushSubscriptions.shopCustomerId} = ${customer.id}
          order by ${shopPushSubscriptions.updatedAt} desc, ${shopPushSubscriptions.id} desc
          offset ${PUSH_SUBSCRIPTIONS_MAX}
        )`);
    });
  }

  /** S15 PS8: only the customer's own row; the same answer when nothing matched. */
  async remove(customer: ShopCustomerIdentity, endpoint: string): Promise<void> {
    await this.limit(customer.id);
    await this.db
      .delete(shopPushSubscriptions)
      .where(
        and(
          eq(shopPushSubscriptions.endpoint, endpoint),
          eq(shopPushSubscriptions.shopCustomerId, customer.id),
        ),
      );
  }

  private async limit(shopCustomerId: string): Promise<void> {
    const allowed = await withinLimits(this.db, [
      { key: `shop-push:${shopCustomerId}`, max: PUSH_CHANGES_PER_HOUR, windowMs: HOUR },
    ]);
    if (!allowed) throw new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');
  }
}

/** The browser's key must be a point of P-256, or the worker could not encrypt for it. */
function onCurve(p256dh: string): boolean {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(Buffer.from(p256dh, 'base64url'));
    return true;
  } catch {
    return false;
  }
}
