import { Inject, Injectable } from '@nestjs/common';
import {
  type CustomerNotification,
  type EmailTemplate,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationListQuery,
  type NotificationPage,
  type NotificationPreferences,
  type UpdateNotificationPreference,
} from '@vertex-digital/contracts';
import {
  type CustomerNotificationInput,
  customerNotifications,
  type Database,
  type EmailInput,
  notificationPreferences,
  notifyCustomer,
  queueEmail,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { and, count, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';

export type { EmailInput };

type NotificationRow = typeof customerNotifications.$inferSelect;

/**
 * The email outbox (S01 rules E1–E5) and the customer notification center (S05 F27, rules
 * NT1–NT8). Emails and notifications are written in the caller's transaction (`queueEmail`,
 * `notifyCustomer` from `@vertex-digital/db`), so they exist only if the change that causes them
 * commits. The API never talks to SMTP; the worker sends.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  queueEmail<Template extends EmailTemplate>(
    tx: Transaction,
    email: EmailInput<Template>,
  ): Promise<string> {
    return queueEmail(tx, this.jobs, email);
  }

  /**
   * A customer event (rule NT1) in the caller's transaction: the notification, its email unless
   * the customer turned it off, and the live event at commit.
   */
  async notifyCustomer<Event extends NotificationEvent>(
    tx: Transaction,
    input: CustomerNotificationInput<Event>,
  ): Promise<void> {
    await notifyCustomer(tx, this.jobs, input);
  }

  /** The customer's notifications, newest first, with the unread count (rule NT5). */
  async list(customerId: string, query: NotificationListQuery): Promise<NotificationPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db
      .select({ row: customerNotifications, at: cursorTime(customerNotifications.createdAt) })
      .from(customerNotifications)
      .where(
        and(
          eq(customerNotifications.customerId, customerId),
          cursor
            ? after(customerNotifications.createdAt, customerNotifications.id, cursor)
            : undefined,
        ),
      )
      .orderBy(desc(customerNotifications.createdAt), desc(customerNotifications.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ row, at }) => ({ at, id: row.id }));
    return {
      items: page.items.map(({ row }) => shape(row)),
      nextCursor: page.nextCursor,
      unreadCount: await this.unreadCount(customerId),
    };
  }

  /** One notification of this customer, as the stream sends it; null for anyone else's. */
  async find(
    id: string,
  ): Promise<{ customerId: string; notification: CustomerNotification } | null> {
    const [row] = await this.db
      .select()
      .from(customerNotifications)
      .where(eq(customerNotifications.id, id));
    return row ? { customerId: row.customerId, notification: shape(row) } : null;
  }

  /** Computed per request from the partial index (rule NT5). */
  async unreadCount(customerId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(customerNotifications)
      .where(
        and(eq(customerNotifications.customerId, customerId), isNull(customerNotifications.readAt)),
      );
    return row?.count ?? 0;
  }

  /**
   * Marks everything up to `upToId`, included, as read (rule NT5): notifications newer than the
   * page the customer saw stay unread. Not audited.
   */
  async markRead(customerId: string, upToId: string): Promise<{ unreadCount: number }> {
    const [upTo] = await this.db
      .select({ id: customerNotifications.id, at: cursorTime(customerNotifications.createdAt) })
      .from(customerNotifications)
      .where(
        and(eq(customerNotifications.id, upToId), eq(customerNotifications.customerId, customerId)),
      );
    if (!upTo) throw new CodedException(404, 'NOT_FOUND', 'No such notification');
    await this.db
      .update(customerNotifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(customerNotifications.customerId, customerId),
          isNull(customerNotifications.readAt),
          or(
            sql`${customerNotifications.createdAt} < ${upTo.at}::timestamptz`,
            and(
              sql`${customerNotifications.createdAt} = ${upTo.at}::timestamptz`,
              lte(customerNotifications.id, upTo.id),
            ),
          ),
        ),
      );
    return { unreadCount: await this.unreadCount(customerId) };
  }

  /** The email choice per event; a missing row means on (rule NT8). */
  async preferences(
    customerId: string,
    db: Database | Transaction = this.db,
  ): Promise<NotificationPreferences> {
    const rows = await db
      .select({ event: notificationPreferences.event, email: notificationPreferences.email })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.customerId, customerId));
    const chosen = new Map(rows.map((row) => [row.event, row.email]));
    return {
      email: Object.fromEntries(
        NOTIFICATION_EVENTS.map((event) => [event, chosen.get(event) ?? true]),
      ) as NotificationPreferences['email'],
    };
  }

  /**
   * One email choice (rule NT8), with its audit entry; the same value again changes nothing. It
   * applies to emails queued after it.
   */
  async setPreference(
    customerId: string,
    input: UpdateNotificationPreference,
    meta: RequestMeta,
  ): Promise<NotificationPreferences> {
    return this.db.transaction(async (tx) => {
      // The default as a row first, so the row lock serializes two first changes of one choice.
      await tx
        .insert(notificationPreferences)
        .values({ customerId, event: input.event, email: true })
        .onConflictDoNothing();
      const [current] = await tx
        .select({ email: notificationPreferences.email })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.customerId, customerId),
            eq(notificationPreferences.event, input.event),
          ),
        )
        .for('update');
      if (current?.email !== input.email) {
        await tx
          .update(notificationPreferences)
          .set({ email: input.email })
          .where(
            and(
              eq(notificationPreferences.customerId, customerId),
              eq(notificationPreferences.event, input.event),
            ),
          );
        await recordAudit(tx, {
          action: 'customer.notification_preference_changed',
          actorKind: 'customer',
          actorId: customerId,
          channel: 'store',
          entityType: 'customer',
          entityId: customerId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          details: { event: input.event, email: input.email },
        });
      }
      return this.preferences(customerId, tx);
    });
  }
}

function shape(row: NotificationRow): CustomerNotification {
  return {
    id: row.id,
    event: row.event,
    params: row.params,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  } as CustomerNotification;
}
