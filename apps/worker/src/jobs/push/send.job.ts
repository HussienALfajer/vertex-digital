import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import {
  isPushNotificationEvent,
  type PushSendPayload,
  pushEndpointAllowed,
  pushSendPayloadSchema,
  QUEUES,
  vapidKeyId,
} from '@vertex-digital/contracts';
import {
  customerNotifications,
  customerSessions,
  type Database,
  notificationPreferences,
  PUSH_SEND_OPTIONS,
  pushSubscriptions,
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
  pushUrgency,
} from './push-rules.js';
import { renderPush } from './push-texts.js';

/** What one run did, for the tests and the logs; never a key or the payload. */
export interface PushRunResult {
  /** Why nothing was sent, when nothing was. */
  skipped?: 'not_configured' | 'missing' | 'too_old' | 'turned_off';
  /** Per device: its answer, or `host_refused` when the endpoint failed the re-check (PS2). */
  outcomes: Record<string, PushOutcome | 'host_refused'>;
  /** The devices queued for the next retry. */
  retried: string[];
}

type Device = typeof pushSubscriptions.$inferSelect;

/**
 * `push.send` (S15 PD1–PD7): one notification to the customer's push devices. Everything is read
 * at run time (PD2): the push preference, and the devices of live sessions made with the current
 * key (a device of another key is deleted, PS7). The payload is rendered once (PT1) and sent
 * outside any transaction, 5 devices at a time; each answer is settled on its own row (PD4).
 * Transient failures are retried by a new job naming only those devices, 60 seconds then 5
 * minutes later (PD5); pg-boss itself never retries (`PUSH_SEND_OPTIONS`). Safe to run twice: a
 * repeat shows as the same notification on the device (same tag), replacing the first (PD6).
 */
@Injectable()
export class SendPushJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SendPushJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly sender: PushSender,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<PushSendPayload>(QUEUES.pushSend, async (data) => {
      await this.send(pushSendPayloadSchema.parse(data));
    });
    this.logger.log(`Working ${QUEUES.pushSend}`);
  }

  async send(payload: PushSendPayload, now = new Date()): Promise<PushRunResult> {
    const result: PushRunResult = { outcomes: {}, retried: [] };
    const publicKey = this.sender.publicKey;
    if (!publicKey) return { ...result, skipped: 'not_configured' };

    const [row] = await this.db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.id, payload.notificationId));
    if (!row || !isPushNotificationEvent(row.event)) return { ...result, skipped: 'missing' };
    if (now.getTime() - row.createdAt.getTime() >= PUSH_MAX_AGE_SECONDS * 1000) {
      return { ...result, skipped: 'too_old' };
    }
    const [preference] = await this.db
      .select({ push: notificationPreferences.push })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.customerId, row.customerId),
          eq(notificationPreferences.event, row.event),
        ),
      );
    // A missing preference means on (PP1).
    if (preference?.push === false) return { ...result, skipped: 'turned_off' };

    const keyId = vapidKeyId(publicKey);
    // PS7: devices made with another key can no longer be pushed to; they subscribe again with
    // the current key on their next signed-in visit.
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.customerId, row.customerId),
          ne(pushSubscriptions.vapidKeyId, keyId),
        ),
      );
    const devices = await this.db
      .select({ device: pushSubscriptions })
      .from(pushSubscriptions)
      .innerJoin(customerSessions, eq(customerSessions.id, pushSubscriptions.sessionId))
      .where(
        and(
          eq(pushSubscriptions.customerId, row.customerId),
          eq(pushSubscriptions.vapidKeyId, keyId),
          gt(customerSessions.expiresAt, now),
          payload.subscriptionIds
            ? inArray(pushSubscriptions.id, payload.subscriptionIds)
            : undefined,
        ),
      );
    if (devices.length === 0) return result;

    const rendered = renderPush(row.event, row.params);
    const request = {
      notificationId: row.id,
      payload: JSON.stringify(rendered),
      ttlSeconds: pushTtlSeconds(row.createdAt, now),
      urgency: pushUrgency(row.event),
      topic: pushTopic(rendered.tag),
    };

    const queue = devices.map(({ device }) => device);
    const work = async () => {
      for (let device = queue.shift(); device; device = queue.shift()) {
        result.outcomes[device.id] = await this.sendOne(device, request, result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, queue.length) }, work));

    const refused = Object.values(result.outcomes).filter((outcome) => outcome === 'refused');
    if (refused.length > 0) {
      // A13: one event per job, never the payload or the keys.
      const message = `push.send: ${refused.length} device(s) refused notification ${row.id}`;
      this.logger.warn(message);
      this.reportRefusals(message);
    }
    const retry = payload.retry ?? 0;
    const delay = PUSH_RETRY_DELAYS_SECONDS[retry];
    if (result.retried.length > 0 && delay !== undefined) {
      await this.pgBoss.boss.send(
        QUEUES.pushSend,
        { notificationId: row.id, subscriptionIds: result.retried, retry: retry + 1 },
        { ...PUSH_SEND_OPTIONS, startAfter: delay },
      );
    } else {
      result.retried = [];
    }
    return result;
  }

  /**
   * A13's Sentry event for the refused devices. A method of its own so the tests watch it with a
   * spy: they run without module isolation, where a module mock of Sentry would reach other files.
   */
  reportRefusals(message: string): void {
    Sentry.captureMessage(message, 'warning');
  }

  /** One device's send and its row settled (PD4, PD5); `transient` ones join `result.retried`. */
  private async sendOne(
    device: Device,
    request: Parameters<PushSender['send']>[1],
    result: PushRunResult,
  ): Promise<PushOutcome | 'host_refused'> {
    const byId = eq(pushSubscriptions.id, device.id);
    // PS2 again: the URL is one a customer gave us.
    if (!pushEndpointAllowed(device.endpoint)) {
      await this.db.delete(pushSubscriptions).where(byId);
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
        .update(pushSubscriptions)
        .set({ lastSentAt: sql`now()`, failures: 0 })
        .where(byId);
    } else if (outcome === 'gone') {
      await this.db.delete(pushSubscriptions).where(byId);
    } else if (outcome === 'transient') {
      const [counted] = await this.db
        .update(pushSubscriptions)
        .set({ failures: sql`${pushSubscriptions.failures} + 1` })
        .where(byId)
        .returning({ failures: pushSubscriptions.failures });
      if (counted && counted.failures >= PUSH_FAILURES_MAX) {
        await this.db.delete(pushSubscriptions).where(byId);
      } else if (counted) {
        result.retried.push(device.id);
      }
    }
    return outcome;
  }
}
