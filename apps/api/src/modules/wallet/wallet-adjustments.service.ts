import { Inject, Injectable } from '@nestjs/common';
import {
  type Adjustment,
  type AdjustmentCategory,
  type AdjustmentDirection,
  amountConfirmationError,
  type CreateAdjustment,
  isUsdtMethod,
  type ManualDepositMethod,
  normalizeTxid,
  type ReverseAdjustment,
} from '@vertex-digital/contracts';
import {
  accountBalance,
  claimPaymentReference,
  type Database,
  ensureSystemAccount,
  findCustomerWallet,
  LedgerError,
  lockCustomerWallet,
  newId,
  type PaymentReferenceOwner,
  paymentReferenceOwner,
  postJournal,
  recordAudit,
  walletAdjustments,
  walletBalanceAfter,
} from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { AuthService } from '../auth/index.js';
import { NotificationsService } from '../notifications/index.js';

type AdjustmentRow = typeof walletAdjustments.$inferSelect;

/** What one adjustment request asks for; a replay must ask for exactly the same (rule J9). */
interface AdjustmentRequest {
  customerId: string;
  direction: AdjustmentDirection;
  amountUnits: number;
  category: AdjustmentCategory;
  reason: string;
  customerNote: string | null;
  depositMethod: ManualDepositMethod | null;
  externalReference: string | null;
  reversesAdjustmentId: string | null;
}

interface Written {
  adjustment: Adjustment;
  /** False on a replay of an earlier request with the same key: nothing was written. */
  created: boolean;
}

/** A PostgreSQL unique violation's constraint, raw or wrapped by Drizzle; null otherwise. */
function violatedConstraint(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    const { code, constraint } = (candidate ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505') return typeof constraint === 'string' ? constraint : '';
  }
  return null;
}

const refusals = {
  /** `details` names the record that holds the reference (S03 rule SC14). */
  externalReferenceTaken: (owner: PaymentReferenceOwner | null) =>
    new CodedException(
      409,
      'EXTERNAL_REFERENCE_TAKEN',
      'The external reference is already recorded for this method',
      owner ?? undefined,
    ),
  alreadyReversed: () =>
    new CodedException(409, 'ADJUSTMENT_ALREADY_REVERSED', 'The adjustment was already reversed'),
};

/** Thrown inside the write's transaction when its key committed first: answered as a replay. */
class AlreadyWritten extends Error {}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/**
 * A manual deposit's reference as it is claimed: a USDT TXID normalized as the worker claims it
 * (S04: `0x`, a link or another case are the same claim), refused when it is not a TXID.
 */
function externalReferenceOf(input: CreateAdjustment): string | null {
  const reference = input.externalReference ?? null;
  if (reference === null || !input.depositMethod || !isUsdtMethod(input.depositMethod)) {
    return reference;
  }
  const txid = normalizeTxid(reference);
  if (!txid) {
    throw new CodedException(400, 'VALIDATION_FAILED', 'Expected a TXID', [
      { path: ['externalReference'], message: 'Expected a TXID or an explorer link' },
    ]);
  }
  return txid;
}

/**
 * The admin's wallet adjustments and their reversals (S02 rules J1–J10, R1–R5, M1–M3): the only
 * writer of `wallet_adjustments`. The row, its journal, its audit entry and its email are written
 * in one READ COMMITTED transaction (rule J3); the request's `Idempotency-Key` makes a retry
 * return the first result (rule J9).
 */
@Injectable()
export class WalletAdjustmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly customers: AuthService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    adminId: string,
    customerId: string,
    idempotencyKey: string,
    input: CreateAdjustment & { reason: string },
    meta: RequestMeta,
  ): Promise<Written> {
    const request: AdjustmentRequest = {
      customerId,
      direction: input.direction,
      amountUnits: input.amountUnits,
      category: input.category,
      reason: input.reason,
      customerNote: input.customerNote ?? null,
      depositMethod: input.depositMethod ?? null,
      externalReference: externalReferenceOf(input),
      reversesAdjustmentId: null,
    };
    const replayed = await this.replay(idempotencyKey, request);
    if (replayed) return replayed;

    const customer = isUuid(customerId) ? await this.customers.walletCustomer(customerId) : null;
    if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
    this.checkConfirmation(input.amountUnits, input.amountConfirmationUnits);
    if (input.category === 'test_funds' && !customer.isTest) {
      throw new CodedException(
        400,
        'ADJUSTMENT_NOT_ALLOWED',
        'Test funds are for test customers only',
      );
    }
    return this.write(adminId, idempotencyKey, request, meta);
  }

  async reverse(
    adminId: string,
    adjustmentId: string,
    idempotencyKey: string,
    input: ReverseAdjustment & { reason: string },
    meta: RequestMeta,
  ): Promise<Written> {
    const [original] = isUuid(adjustmentId)
      ? await this.db.select().from(walletAdjustments).where(eq(walletAdjustments.id, adjustmentId))
      : [];
    if (!original) throw new CodedException(404, 'NOT_FOUND', 'No such adjustment');
    const request: AdjustmentRequest = {
      customerId: original.customerId,
      direction: original.direction === 'credit' ? 'debit' : 'credit',
      amountUnits: original.amountUsdUnits,
      category: original.category,
      reason: input.reason,
      customerNote: input.customerNote ?? null,
      depositMethod: null,
      externalReference: null,
      reversesAdjustmentId: original.id,
    };
    const replayed = await this.replay(idempotencyKey, request);
    if (replayed) return replayed;

    if (original.reversesAdjustmentId) {
      throw new CodedException(
        409,
        'ADJUSTMENT_NOT_REVERSIBLE',
        'A reversal cannot be reversed; make a correction instead',
      );
    }
    const [reversed] = await this.db
      .select({ id: walletAdjustments.id })
      .from(walletAdjustments)
      .where(eq(walletAdjustments.reversesAdjustmentId, original.id));
    if (reversed) throw refusals.alreadyReversed();
    this.checkConfirmation(original.amountUsdUnits, input.amountConfirmationUnits);
    return this.write(adminId, idempotencyKey, request, meta);
  }

  private checkConfirmation(amountUnits: number, confirmationUnits: number | undefined): void {
    const refusal = amountConfirmationError(amountUnits, confirmationUnits);
    if (refusal) {
      throw new CodedException(400, refusal, 'The typed amount confirmation does not hold');
    }
  }

  /** The first result of an earlier request with this key, or null; another body is refused. */
  private async replay(
    idempotencyKey: string,
    request: AdjustmentRequest,
  ): Promise<Written | null> {
    const [row] = await this.db
      .select()
      .from(walletAdjustments)
      .where(eq(walletAdjustments.idempotencyKey, idempotencyKey));
    if (!row) return null;
    const same =
      row.customerId === request.customerId &&
      row.direction === request.direction &&
      row.amountUsdUnits === request.amountUnits &&
      row.category === request.category &&
      row.reason === request.reason &&
      row.customerNote === request.customerNote &&
      row.depositMethod === request.depositMethod &&
      row.externalReference === request.externalReference &&
      row.reversesAdjustmentId === request.reversesAdjustmentId;
    if (!same) {
      throw new CodedException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was used for another request',
      );
    }
    const accountId = await findCustomerWallet(this.db, row.customerId);
    if (!accountId) throw new Error(`Adjustment ${row.id} has no wallet`);
    const balanceAfterUnits = await walletBalanceAfter(this.db, accountId, row.journalId);
    return { adjustment: shape(row, balanceAfterUnits), created: false };
  }

  /** Rules J2, J3, J5, M1–M3: journal, row, audit entry and notification in one transaction. */
  private async write(
    adminId: string,
    idempotencyKey: string,
    request: AdjustmentRequest,
    meta: RequestMeta,
  ): Promise<Written> {
    const id = newId();
    const signed = request.direction === 'credit' ? request.amountUnits : -request.amountUnits;
    try {
      return await this.db.transaction(async (tx) => {
        // Adjustments of one wallet queue here, so a parallel request with the same key or the
        // same reversal sees the first one's row once it commits (rules J9, R2), before the
        // balance check could refuse it as a debit.
        const wallet = await lockCustomerWallet(tx, request.customerId);
        const [written] = await tx
          .select({ id: walletAdjustments.id })
          .from(walletAdjustments)
          .where(eq(walletAdjustments.idempotencyKey, idempotencyKey));
        if (written) throw new AlreadyWritten();
        if (request.reversesAdjustmentId) {
          const [reversal] = await tx
            .select({ id: walletAdjustments.id })
            .from(walletAdjustments)
            .where(eq(walletAdjustments.reversesAdjustmentId, request.reversesAdjustmentId));
          if (reversal) throw refusals.alreadyReversed();
        }
        const counter = await ensureSystemAccount(tx, {
          code: `adjustments:${request.category}`,
          kind: 'adjustments',
          currency: 'USD',
        });
        let journalId: string;
        try {
          ({ journalId } = await postJournal(tx, {
            idempotencyKey: `adjustment:${id}`,
            kind: 'adjustment',
            postings: [
              { accountId: wallet, amountUnits: signed },
              { accountId: counter, amountUnits: -signed },
            ],
          }));
        } catch (error) {
          if (error instanceof LedgerError && error.code === 'INSUFFICIENT_BALANCE') {
            // The dialog shows the balance the debit met (rule J5, edge case 3).
            throw new CodedException(409, 'INSUFFICIENT_BALANCE', error.message, {
              balanceUnits: await accountBalance(tx, wallet),
            });
          }
          throw error;
        }
        const [row] = await tx
          .insert(walletAdjustments)
          .values({
            id,
            customerId: request.customerId,
            direction: request.direction,
            amountUsdUnits: request.amountUnits,
            category: request.category,
            customerNote: request.customerNote,
            reason: request.reason,
            depositMethod: request.depositMethod,
            externalReference: request.externalReference,
            reversesAdjustmentId: request.reversesAdjustmentId,
            journalId,
            idempotencyKey,
            adminId,
          })
          .returning();
        if (!row) throw new Error(`Adjustment ${id} was not written`);
        if (request.depositMethod && request.externalReference) {
          // One claim per real payment across deposits and adjustments (S03 rule SC14).
          try {
            await claimPaymentReference(tx, request.depositMethod, request.externalReference, {
              walletAdjustmentId: id,
            });
          } catch (error) {
            if (error instanceof LedgerError && error.code === 'EXTERNAL_REFERENCE_TAKEN') {
              throw refusals.externalReferenceTaken(error.details as PaymentReferenceOwner | null);
            }
            throw error;
          }
        }
        const balanceAfterUnits = await walletBalanceAfter(tx, wallet, journalId);
        const audited = {
          customerId: request.customerId,
          direction: request.direction,
          amountUnits: request.amountUnits,
          category: request.category,
          customerNote: request.customerNote,
          journalId,
          balanceAfterUnits,
        };
        const entry = {
          actorKind: 'admin',
          actorId: adminId,
          channel: 'admin',
          entityType: 'wallet_adjustment',
          entityId: id,
          reason: request.reason,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        } as const;
        if (request.reversesAdjustmentId) {
          await recordAudit(tx, {
            ...entry,
            action: 'wallet_adjustment.reversed',
            details: { ...audited, reversedAdjustmentId: request.reversesAdjustmentId },
          });
        } else {
          await recordAudit(tx, {
            ...entry,
            action: 'wallet_adjustment.created',
            details: {
              ...audited,
              depositMethod: request.depositMethod,
              externalReference: request.externalReference,
            },
          });
        }
        // No reason, note or admin name: S01 email rule, S05 rule NT3.
        await this.notifications.notifyCustomer(tx, {
          customerId: request.customerId,
          event: 'wallet_adjusted',
          params: {
            direction: request.direction,
            amountUnits: request.amountUnits,
            category: request.category,
            reversal: request.reversesAdjustmentId !== null,
          },
        });
        return { adjustment: shape(row, balanceAfterUnits), created: true };
      });
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (
        error instanceof AlreadyWritten ||
        constraint === 'wallet_adjustments_idempotency_key_unique'
      ) {
        // The same key committed in parallel (rule J9): answer as its replay.
        const replayed = await this.replay(idempotencyKey, request);
        if (replayed) return replayed;
      }
      if (constraint === 'wallet_adjustments_reverses_adjustment_id_unique') {
        throw refusals.alreadyReversed();
      }
      if (
        constraint === 'wallet_adjustments_external_reference_unique' &&
        request.depositMethod &&
        request.externalReference
      ) {
        throw refusals.externalReferenceTaken(
          await paymentReferenceOwner(this.db, request.depositMethod, request.externalReference),
        );
      }
      throw error;
    }
  }
}

function shape(row: AdjustmentRow, balanceAfterUnits: number): Adjustment {
  return {
    id: row.id,
    customerId: row.customerId,
    direction: row.direction,
    amountUnits: row.amountUsdUnits,
    category: row.category,
    reason: row.reason,
    customerNote: row.customerNote,
    depositMethod: row.depositMethod,
    externalReference: row.externalReference,
    reversesAdjustmentId: row.reversesAdjustmentId,
    journalId: row.journalId,
    createdAt: row.createdAt.toISOString(),
    balanceAfterUnits,
  };
}
