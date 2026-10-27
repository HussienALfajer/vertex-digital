import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  QUEUES,
  type SuppliersWebhookPayload,
  suppliersWebhookPayloadSchema,
  type WebhookEventResult,
} from '@vertex-digital/contracts';
import {
  applyOutcome,
  type Database,
  decryptSecret,
  fulfilmentAttempts,
  orderCodesKey,
  suppliers,
  supplierWebhookEvents,
  type Transaction,
} from '@vertex-digital/db';
import { SupplierError } from '@vertex-digital/suppliers';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';
import {
  attemptOutcome,
  checkCharge,
  orderContext,
  reportLateResult,
  routingContext,
} from '../orders/order-calls.js';

type Executor = Database | Transaction;

/**
 * An event naming only the supplier's order id may come before the first send's answer stored
 * that id: it is read again after this many seconds, while it is younger than `WAIT_FOR_SEND_MS`,
 * before it is kept as `unknown_key` (audit A04-25).
 */
const RETRY_UNMATCHED_SECONDS = 30;
const WAIT_FOR_SEND_MS = 3 * 60_000;

/**
 * `suppliers.webhook` (S08 rule F5): one stored, verified event. Its body is decrypted and parsed
 * by the supplier's adapter, the attempt found by its key and supplier, and the result applied by
 * rule F1 (`resolvedBy = webhook`). An event for a closed attempt is `same_result` when it agrees
 * and `conflict` when it does not (delivered after failed, or failed after delivered): nothing
 * changes but a `note` on the order and an `order_conflict` alert. `processed_at` makes a second
 * run a no-op. The body may carry codes: never logged.
 */
@Injectable()
export class SupplierWebhookJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierWebhookJob.name);
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
    await this.pgBoss.work<SuppliersWebhookPayload>(QUEUES.suppliersWebhook, async (data) => {
      const result = await this.process(suppliersWebhookPayloadSchema.parse(data).eventId);
      if (result === 'conflict' || result === 'unknown_key' || result === 'malformed') {
        this.logger.warn(`Supplier webhook ${data.eventId}: ${result}`);
      }
    });
  }

  /** The event's result, or null when it was already processed. */
  async process(
    eventId: string,
    db: Executor = this.db,
    now = new Date(),
  ): Promise<WebhookEventResult | null> {
    const [event] = await db
      .select({ event: supplierWebhookEvents, supplierCode: suppliers.code })
      .from(supplierWebhookEvents)
      .innerJoin(suppliers, eq(suppliers.id, supplierWebhookEvents.supplierId))
      .where(eq(supplierWebhookEvents.id, eventId));
    if (!event) throw new Error(`Supplier webhook event ${eventId} does not exist`);
    if (event.event.processedAt) return null;
    const { supplierId } = event.event;

    const parsed = await this.parse(db, event.event, event.supplierCode);
    if (parsed === 'malformed') return this.finish(db, eventId, 'malformed', null);
    // S19 FC7: a test, a creation, a chat message: kept, never applied.
    if (parsed.event.ignored) return this.finish(db, eventId, 'ignored', null);
    const { idempotencyKey, supplierOrderId } = parsed.event;
    // By the key the attempt was sent with, or by the supplier's own order id when its webhooks
    // carry only that (WDGZone). Two attempts with one supplier order id answer nothing.
    const match =
      idempotencyKey !== undefined
        ? z.uuid().safeParse(idempotencyKey).success
          ? eq(fulfilmentAttempts.id, idempotencyKey)
          : null
        : supplierOrderId
          ? eq(fulfilmentAttempts.supplierOrderId, supplierOrderId)
          : null;
    const matches = match
      ? await db
          .select({ id: fulfilmentAttempts.id })
          .from(fulfilmentAttempts)
          .where(and(match, eq(fulfilmentAttempts.supplierId, supplierId)))
          .limit(2)
      : [];
    const attempt = matches.length === 1 ? matches[0] : undefined;
    if (
      !attempt &&
      matches.length === 0 &&
      idempotencyKey === undefined &&
      supplierOrderId &&
      now.getTime() - event.event.createdAt.getTime() < WAIT_FOR_SEND_MS
    ) {
      // Faster than the first send's answer: read again shortly, still unprocessed.
      const { jobs } = orderContext(this.pgBoss, this.codesKey);
      await db.transaction((tx) =>
        jobs.send(
          tx,
          QUEUES.suppliersWebhook,
          { eventId },
          { startAfter: RETRY_UNMATCHED_SECONDS },
        ),
      );
      return null;
    }
    // Another environment's or an old order: kept, nothing changes (edge case 19).
    if (!attempt) return this.finish(db, eventId, 'unknown_key', null);

    const outcome = attemptOutcome(parsed.event.outcome, parsed.secrets);
    return db.transaction(async (tx) => {
      // The event row first: a second job for it waits here, then finds it processed.
      const [locked] = await tx
        .select({ processedAt: supplierWebhookEvents.processedAt })
        .from(supplierWebhookEvents)
        .where(eq(supplierWebhookEvents.id, eventId))
        .for('update');
      if (locked?.processedAt) return null;
      const context = orderContext(this.pgBoss, this.codesKey);
      const applied = await applyOutcome(tx, context, attempt.id, outcome, { by: 'webhook' });
      if (applied.applied) {
        await checkCharge(tx, applied, { ...routingContext(this.env), jobs: context.jobs });
      }
      const result: WebhookEventResult = applied.applied
        ? 'applied'
        : await reportLateResult(tx, context, applied, outcome, { kind: 'webhook', eventId });
      return this.finish(tx, eventId, result, attempt.id);
    });
  }

  /** The adapter's reading of the body, or `malformed`. */
  private async parse(
    db: Executor,
    event: typeof supplierWebhookEvents.$inferSelect,
    code: typeof suppliers.$inferSelect.code,
  ) {
    // The API stores a body its adapter could not parse under its digest (S08 PR 1).
    if (event.eventId.startsWith('malformed:')) return 'malformed' as const;
    const connected = await this.registry.connect(db, { id: event.supplierId, code });
    // The adapter was here when the API verified the event: its absence now is ours to fix.
    if (!connected) throw new Error(`No adapter for ${code} to read webhook ${event.id}`);
    const rawBody = decryptSecret(this.codesKey, event.id, event.bodyCiphertext);
    try {
      return {
        event: connected.adapter.parseWebhook({ headers: {}, rawBody }),
        secrets: connected.secrets,
      };
    } catch (error) {
      if (error instanceof SupplierError) return 'malformed' as const;
      throw error;
    }
  }

  private async finish(
    db: Executor,
    eventId: string,
    result: WebhookEventResult,
    attemptId: string | null,
  ): Promise<WebhookEventResult | null> {
    const [row] = await db
      .update(supplierWebhookEvents)
      .set({ processedAt: new Date(), result, attemptId })
      .where(and(eq(supplierWebhookEvents.id, eventId), isNull(supplierWebhookEvents.processedAt)))
      .returning({ id: supplierWebhookEvents.id });
    return row ? result : null;
  }
}
