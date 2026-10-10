import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminOrder,
  type DayBounds,
  type DeliveryProof,
  type fulfilOrderSchema,
  type LiveBoard,
  type LiveBoardQuery,
  orderDecisions,
  type RerouteOptions,
  type RerouteOrder,
} from '@vertex-digital/contracts';
import {
  ADMIN_CLOSE_REASONS,
  type Database,
  fulfilmentAttempts,
  fulfilOrderManually,
  liveBoard,
  liveCounts,
  lockOrder,
  openAttempt,
  orderCodesKey,
  orderFigures,
  orders,
  recordAudit,
  rerouteOptions,
  rerouteOrder,
} from '@vertex-digital/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation, violatedConstraint } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import { JobsService } from '../../core/jobs/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { type DecisionActor, OrderDecisionsService } from './order-decisions.service.js';
import { asCodedException, orderRefusals } from './order-errors.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

type FulfilBody = z.output<typeof fulfilOrderSchema>;

const proofInvalid = () =>
  new CodedException(400, 'PROOF_INVALID', 'The delivery proof is missing or already used');

/**
 * The admin's live room and actions (S11 rules LR1–LR3, RR1–RR5, MF1–MF6): the board, the route
 * options, reroute, the delivery proof and the manual fulfil. Each action runs the write path of
 * `packages/db` (order lock, then attempt) with its audit entry in one transaction; its
 * `Idempotency-Key` stays on the attempt it closed or delivered, so the same key answers the
 * order as the first request left it.
 */
@Injectable()
export class OrderActionsService {
  private readonly codesKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly decisions: OrderDecisionsService,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET as string);
  }

  /** S11 rules DB2–DB4, DB6: the dashboard's order figures and the live counts. */
  async figures(bounds: DayBounds, now: Date) {
    const [figures, live] = await Promise.all([
      orderFigures(this.db, bounds, now),
      liveCounts(this.db, now),
    ]);
    return { ...figures, live };
  }

  board(query: LiveBoardQuery): Promise<LiveBoard> {
    return liveBoard(this.db, query, new Date());
  }

  /** Rule RR2: the routes with their eligibility; only while a reroute is possible. */
  async routes(orderId: string): Promise<RerouteOptions> {
    const order = await this.decidable(orderId, 'reroute');
    return rerouteOptions(this.db, order, routingContext(this.env));
  }

  /** The order when the decision is open on it now (unlocked: the action rechecks under locks). */
  private async decidable(orderId: string, decision: 'reroute' | 'fulfil') {
    const [order] = isUuid(orderId)
      ? await this.db.select().from(orders).where(eq(orders.id, orderId))
      : [];
    if (!order) throw orderRefusals.notFound();
    const open = await openAttempt(this.db, orderId);
    const decisions = orderDecisions(
      order.status,
      open ? { id: open.attempt.id, supplierCode: open.supplierCode } : null,
    );
    if (!decisions[decision]) throw orderRefusals.notDecidable();
    return order;
  }

  /** Rule RR3, with its audit entry; the same key answers the order as it was left. */
  async reroute(
    actor: DecisionActor,
    orderId: string,
    idempotencyKey: string,
    body: RerouteOrder,
  ): Promise<{ order: AdminOrder; created: boolean }> {
    if (!isUuid(orderId)) throw orderRefusals.notFound();
    if (await this.replayed(orderId, idempotencyKey, 'reroute')) {
      return { order: await this.decisions.order(orderId), created: false };
    }
    try {
      const created = await this.db.transaction(async (tx) => {
        // The same key waited on the lock behind its first request: a replay.
        await lockOrder(tx, orderId);
        if (await this.replayed(orderId, idempotencyKey, 'reroute', tx)) return false;
        const result = await rerouteOrder(
          tx,
          {
            jobs: this.jobs,
            codesKey: this.codesKey,
            now: new Date(),
            routing: routingContext(this.env),
          },
          {
            orderId,
            routeId: body.routeId,
            admin: { id: actor.adminId, reason: body.reason, idempotencyKey },
          },
        );
        await recordAudit(tx, {
          action: 'order.rerouted',
          actorKind: 'admin',
          actorId: actor.adminId,
          channel: 'admin',
          entityType: 'order',
          entityId: orderId,
          reason: body.reason,
          details: {
            closedAttemptId: result.closedAttemptId,
            attemptId: result.attempt.id,
            routeId: body.routeId,
            supplier: result.supplierCode,
          },
          ...actor.meta,
        });
        return true;
      });
      return { order: await this.decisions.order(orderId), created };
    } catch (error) {
      if (isUniqueViolation(error) && (await this.replayed(orderId, idempotencyKey, 'reroute'))) {
        return { order: await this.decisions.order(orderId), created: false };
      }
      throw asCodedException(error);
    }
  }

  /** Rule MF2: the proof re-encoded and stored, audited; only while a fulfil is possible. */
  async uploadProof(
    actor: DecisionActor,
    orderId: string,
    upload: Buffer | undefined,
  ): Promise<DeliveryProof> {
    await this.decidable(orderId, 'fulfil');
    const prepared = await this.files.prepare('delivery_proof', upload);
    const fileId = await this.db.transaction(async (tx) => {
      const id = await this.files.record(tx, prepared);
      await recordAudit(tx, {
        action: 'order.proof_uploaded',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'order',
        entityId: orderId,
        details: { fileId: id },
        ...actor.meta,
      });
      return id;
    });
    return { fileId };
  }

  /** A proof one of the order's attempts holds; never another order's. */
  async proof(orderId: string, fileId: string): Promise<ServedFile> {
    const [used] =
      isUuid(orderId) && isUuid(fileId)
        ? await this.db
            .select({ id: fulfilmentAttempts.id })
            .from(fulfilmentAttempts)
            .where(
              and(
                eq(fulfilmentAttempts.orderId, orderId),
                eq(fulfilmentAttempts.proofFileId, fileId),
              ),
            )
        : [];
    const file = used ? await this.files.serve(fileId, 'delivery_proof') : null;
    if (!file) throw new CodedException(404, 'NOT_FOUND', 'No such proof');
    return file;
  }

  /** Rules MF1–MF5, with the audit entry of AU1 (never the codes). */
  async fulfil(
    actor: DecisionActor,
    orderId: string,
    idempotencyKey: string,
    body: FulfilBody,
  ): Promise<{ order: AdminOrder; created: boolean }> {
    if (!isUuid(orderId)) throw orderRefusals.notFound();
    if (await this.replayed(orderId, idempotencyKey, 'fulfil')) {
      return { order: await this.decisions.order(orderId), created: false };
    }
    try {
      const created = await this.db.transaction(async (tx) => {
        await lockOrder(tx, orderId);
        if (await this.replayed(orderId, idempotencyKey, 'fulfil', tx)) return false;
        const result = await fulfilOrderManually(
          tx,
          { jobs: this.jobs, codesKey: this.codesKey, now: new Date() },
          {
            orderId,
            quantity: body.quantity,
            codes: body.codes,
            unitCostUsdUnits: body.unitCostUsdUnits,
            acceptLoss: body.acceptLoss,
            proofFileId: body.proofFileId,
            reference: body.reference ?? null,
            admin: { id: actor.adminId, reason: body.reason, idempotencyKey },
          },
        );
        await recordAudit(tx, {
          action: 'order.fulfilled_manually',
          actorKind: 'admin',
          actorId: actor.adminId,
          channel: 'admin',
          entityType: 'order',
          entityId: orderId,
          reason: body.reason,
          details: {
            attemptId: result.attemptId,
            case: result.case,
            units: body.quantity,
            unitCostUsdUnits: body.unitCostUsdUnits,
            lossAccepted: result.lossAccepted,
            proofFileId: body.proofFileId,
            hasReference: body.reference !== undefined,
            items: body.codes.length,
          },
          ...actor.meta,
        });
        return true;
      });
      return { order: await this.decisions.order(orderId), created };
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (await this.replayed(orderId, idempotencyKey, 'fulfil')) {
          return { order: await this.decisions.order(orderId), created: false };
        }
        // Another order took the same proof at the same moment.
        if (violatedConstraint(error) === 'fulfilment_attempts_proof_file_id_unique') {
          throw proofInvalid();
        }
      }
      throw asCodedException(error);
    }
  }

  /**
   * True when the key already made this action on this order; refused when it was used for
   * anything else (another order, another decision).
   */
  private async replayed(
    orderId: string,
    key: string,
    action: 'reroute' | 'fulfil',
    db: Pick<Database, 'select'> = this.db,
  ): Promise<boolean> {
    const [[attempt], [refunded]] = await Promise.all([
      db
        .select({
          orderId: fulfilmentAttempts.orderId,
          failureReason: fulfilmentAttempts.failureReason,
          proofFileId: fulfilmentAttempts.proofFileId,
        })
        .from(fulfilmentAttempts)
        .where(eq(fulfilmentAttempts.decisionIdempotencyKey, key)),
      db.select({ id: orders.id }).from(orders).where(eq(orders.refundIdempotencyKey, key)),
    ]);
    if (refunded) throw orderRefusals.keyReused();
    if (!attempt) return false;
    const same =
      action === 'reroute'
        ? attempt.failureReason === ADMIN_CLOSE_REASONS.reroute
        : attempt.proofFileId !== null;
    if (attempt.orderId !== orderId || !same) throw orderRefusals.keyReused();
    return true;
  }
}
