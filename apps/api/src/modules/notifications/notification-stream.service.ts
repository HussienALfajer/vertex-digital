import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { NotificationStreamEvent } from '@vertex-digital/contracts';
import { CUSTOMER_NOTIFICATIONS_CHANNEL } from '@vertex-digital/db';
import type { Request, Response } from 'express';
import pg from 'pg';
import { ENV, type Env } from '../../core/config/env.js';
import { CodedException } from '../../core/errors/index.js';
import { NotificationsService } from './notifications.service.js';

/** Rule NT6: limits and timings of the live stream. */
const MAX_STREAMS = 3;
const CONNECTS_PER_MINUTE = 30;
const HEARTBEAT_MS = 25_000;
const SESSION_CHECK_MS = 5 * 60_000;
const RECONNECT_MAX_MS = 30_000;

interface Stream {
  customerId: string;
  response: Response;
  sessionValid: () => Promise<boolean>;
  close: () => void;
}

/**
 * The notification stream (S05 rule NT6): one `LISTEN customer_notifications` connection for the
 * process (ADR 0009: one API process), fanned out to the open SSE streams by customer. Opened on
 * the first stream, so a process that serves none holds no connection. When the connection drops
 * it reconnects with backoff, then every stream gets `resync`: notifications are read from the
 * table, so none is lost.
 */
@Injectable()
export class NotificationStreamService implements OnApplicationShutdown {
  private readonly logger = new Logger(NotificationStreamService.name);
  private readonly streams = new Map<string, Stream[]>();
  /** Connect times per customer in the last minute (in memory, as the IP limits). */
  private readonly connects = new Map<string, number[]>();
  private listener: pg.Client | null = null;
  private listening: Promise<void> | null = null;
  private reconnectDelay = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly notifications: NotificationsService,
  ) {}

  /** Opens a stream for the signed-in customer, or refuses it with `429 RATE_LIMITED`. */
  async open(
    customerId: string,
    sessionValid: () => Promise<boolean>,
    request: Request,
    response: Response,
  ): Promise<void> {
    this.countConnect(customerId);
    let gone = false;
    request.once('close', () => {
      gone = true;
    });
    await this.listen();
    const unreadCount = await this.notifications.unreadCount(customerId);
    // The client left while the stream was being prepared: nothing to keep open.
    if (gone) return;

    response.status(200);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('connection', 'keep-alive');
    // nginx: pass each event on at once (also set on the location, ADR 0009).
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();

    const heartbeat = setInterval(() => response.write(': ping\n\n'), HEARTBEAT_MS);
    const sessionCheck = setInterval(() => void this.checkSession(stream), SESSION_CHECK_MS);
    const stream: Stream = {
      customerId,
      response,
      sessionValid,
      close: () => {
        clearInterval(heartbeat);
        clearInterval(sessionCheck);
        this.remove(stream);
        if (!response.writableEnded) response.end();
      },
    };
    request.on('close', stream.close);

    const open = [...(this.streams.get(customerId) ?? []), stream];
    this.streams.set(customerId, open);
    // A 4th stream closes the oldest (edge case 14).
    if (open.length > MAX_STREAMS) open[0]?.close();
    send(response, 'unread', { unreadCount });
  }

  /** Re-runs the session check of every open stream now; the timer does it every 5 minutes. */
  async checkSessions(): Promise<void> {
    await Promise.all([...this.streams.values()].flat().map((stream) => this.checkSession(stream)));
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const stream of [...this.streams.values()].flat()) stream.close();
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => {});
  }

  private countConnect(customerId: string): void {
    const now = Date.now();
    const recent = (this.connects.get(customerId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= CONNECTS_PER_MINUTE) {
      this.connects.set(customerId, recent);
      throw new CodedException(429, 'RATE_LIMITED', 'Too many stream connections');
    }
    this.connects.set(customerId, [...recent, now]);
  }

  private async checkSession(stream: Stream): Promise<void> {
    if (!(await stream.sessionValid())) stream.close();
  }

  private remove(stream: Stream): void {
    const left = (this.streams.get(stream.customerId) ?? []).filter((open) => open !== stream);
    if (left.length > 0) this.streams.set(stream.customerId, left);
    else this.streams.delete(stream.customerId);
  }

  /** Starts listening once; a failed start is retried by the next stream. */
  private listen(): Promise<void> {
    if (!this.listening) {
      this.listening = this.connect().catch((error: unknown) => {
        this.listening = null;
        throw error;
      });
    }
    return this.listening;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.env.DATABASE_URL });
    client.on('notification', (message) => {
      if (message.channel === CUSTOMER_NOTIFICATIONS_CHANNEL && message.payload)
        void this.deliver(message.payload);
    });
    client.on('error', (error) => this.lost(client, error));
    client.on('end', () => this.lost(client, new Error('Connection ended')));
    try {
      await client.connect();
      await client.query(`LISTEN ${CUSTOMER_NOTIFICATIONS_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    this.listener = client;
    this.reconnectDelay = 1_000;
  }

  private lost(client: pg.Client, error: Error): void {
    if (this.listener !== client || this.stopped) return;
    this.listener = null;
    this.logger.warn(`The notification listener was lost: ${error.message}`);
    client.end().catch(() => {});
    this.reconnect();
  }

  private reconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then(
        () => {
          for (const stream of [...this.streams.values()].flat())
            send(stream.response, 'resync', {});
        },
        (error: unknown) => {
          this.logger.warn(`The notification listener cannot reconnect: ${String(error)}`);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
          this.reconnect();
        },
      );
    }, this.reconnectDelay);
  }

  private async deliver(notificationId: string): Promise<void> {
    try {
      const found = await this.notifications.find(notificationId);
      const streams = found ? this.streams.get(found.customerId) : undefined;
      if (!found || !streams) return;
      const unreadCount = await this.notifications.unreadCount(found.customerId);
      for (const stream of streams)
        send(stream.response, 'notification', { notification: found.notification, unreadCount });
    } catch (error) {
      // The customer's next refetch shows it; a delivery failure must not end the process.
      this.logger.error(error);
      Sentry.captureException(error);
    }
  }
}

function send(response: Response, event: NotificationStreamEvent, data: object): void {
  if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
