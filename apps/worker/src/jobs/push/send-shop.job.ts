import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type PushSendPayload,
  pushEndpointAllowed,
  pushSendShopPayloadSchema,
  QUEUES,
  vapidKeyId,
} from '@vertex-digital/contracts';
import {
  type Database,
  merchantShops,
  PUSH_SEND_OPTIONS,
  shopCustomerNotifications,
  shopCustomerSessions,
  shopPushSubscriptions,
} from '@vertex-digital/db';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { PushSender } from '../../push/push-sender.js';
import {
  PUSH_CONCURRENCY,
  PUSH_FAILURES_MAX,
  PUSH_MAX_AGE_SECONDS,
  PUSH_RETRY_DELAYS_SECONDS,
  type PushOutcome,
  pushOutcome,
  pushTopic,
  pushTtlSeconds,
} from './push-rules.js';
import { renderShopPush } from './push-texts.js';
import type { PushRunResult } from './send.job.js';

type Device = typeof shopPushSubscriptions.$inferSelect;

/** Order events reach the lock screen at once; the rest at normal urgency (S15 PD3). */
const HIGH = new Set(['order_delivered', 'order_partially_refunded', 'order_refunded']);

/**
 * `push.send-shop` (S26 PR9, SP1): one shop customer notification to the customer's devices in
 * that shop, as `push.send` does for Vertex customers (S15 PD1–PD7): the devices of live shop
 * sessions made with the current key, the payload rendered once and titled by the shop's name,
 * five devices at a time, each answer settled on its row, transient failures retried by a new job
 * naming those devices. Safe to run twice: the same tag replaces the first notification.
 */
@Injectable()
export class SendShopPushJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SendShopPushJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly sender: PushSender,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<PushSendPayload>(QUEUES.pushSendShop, async (data) => {
      await this.send(pushSendShopPayloadSchema.parse(data));
    });
    this.logger.log(`Working ${QUEUES.pushSendShop}`);
  }

  async send(payload: PushSendPayload, now = new Date()): Promise<PushRunResult> {
    const result: PushRunResult = { outcomes: {}, retried: [] };
    const publicKey = this.sender.publicKey;
    if (!publicKey) return { ...result, skipped: 'not_configured' };
    const [row] = await this.db
      .select({
        notification: shopCustomerNotifications,
        shopName: merchantShops.displayName,
        slug: merchantShops.slug,
      })
      .from(shopCustomerNotifications)
      .innerJoin(merchantShops, eq(merchantShops.id, shopCustomerNotifications.shopId))
      .where(eq(shopCustomerNotifications.id, payload.notificationId));
    if (!row) return { ...result, skipped: 'missing' };
    const { notification } = row;
    if (now.getTime() - notification.createdAt.getTime() >= PUSH_MAX_AGE_SECONDS * 1000) {
      return { ...result, skipped: 'too_old' };
    }
    const keyId = vapidKeyId(publicKey);
    await this.db
      .delete(shopPushSubscriptions)
      .where(
        and(
          eq(shopPushSubscriptions.shopCustomerId, notification.shopCustomerId),
          ne(shopPushSubscriptions.vapidKeyId, keyId),
        ),
      );
    const devices = await this.db
      .select({ device: shopPushSubscriptions })
      .from(shopPushSubscriptions)
      .innerJoin(shopCustomerSessions, eq(shopCustomerSessions.id, shopPushSubscriptions.sessionId))
      .where(
        and(
          eq(shopPushSubscriptions.shopCustomerId, notification.shopCustomerId),
          eq(shopPushSubscriptions.vapidKeyId, keyId),
          gt(shopCustomerSessions.expiresAt, now),
          payload.subscriptionIds
            ? inArray(shopPushSubscriptions.id, payload.subscriptionIds)
            : undefined,
        ),
      );
    if (devices.length === 0) return result;

    const rendered = renderShopPush(notification.event, notification.params, {
      name: row.shopName,
      slug: row.slug,
    });
    const request = {
      notificationId: notification.id,
      payload: JSON.stringify(rendered),
      ttlSeconds: pushTtlSeconds(notification.createdAt, now),
      urgency: HIGH.has(notification.event) ? ('high' as const) : ('normal' as const),
      topic: pushTopic(rendered.tag),
    };
    const queue = devices.map(({ device }) => device);
    const work = async () => {
      for (let device = queue.shift(); device; device = queue.shift()) {
        result.outcomes[device.id] = await this.sendOne(device, request, result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, queue.length) }, work));
    const retry = payload.retry ?? 0;
    const delay = PUSH_RETRY_DELAYS_SECONDS[retry];
    if (result.retried.length > 0 && delay !== undefined) {
      await this.pgBoss.boss.send(
        QUEUES.pushSendShop,
        { notificationId: notification.id, subscriptionIds: result.retried, retry: retry + 1 },
        { ...PUSH_SEND_OPTIONS, startAfter: delay },
      );
    } else {
      result.retried = [];
    }
    return result;
  }

  private async sendOne(
    device: Device,
    request: Parameters<PushSender['send']>[1],
    result: PushRunResult,
  ): Promise<PushOutcome | 'host_refused'> {
    const byId = eq(shopPushSubscriptions.id, device.id);
    if (!pushEndpointAllowed(device.endpoint)) {
      await this.db.delete(shopPushSubscriptions).where(byId);
      return 'host_refused';
    }
    const outcome = pushOutcome(
      await this.sender.send(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        request,
      ),
    );
    if (outcome === 'delivered') {
      await this.db
        .update(shopPushSubscriptions)
        .set({ lastSentAt: sql`now()`, failures: 0 })
        .where(byId);
    } else if (outcome === 'gone') {
      await this.db.delete(shopPushSubscriptions).where(byId);
    } else if (outcome === 'transient') {
      const [counted] = await this.db
        .update(shopPushSubscriptions)
        .set({ failures: sql`${shopPushSubscriptions.failures} + 1` })
        .where(byId)
        .returning({ failures: shopPushSubscriptions.failures });
      if (counted && counted.failures >= PUSH_FAILURES_MAX) {
        await this.db.delete(shopPushSubscriptions).where(byId);
      } else if (counted) {
        result.retried.push(device.id);
      }
    }
    return outcome;
  }
}
