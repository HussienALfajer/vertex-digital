import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminDeposit,
  type AdminUsdtTransferPage,
  type AdminUsdtTransferQuery,
  type ApproveUsdtDeposit,
  floorToWholeCents,
  sameFlags,
  type UsdtMethod,
} from '@vertex-digital/contracts';
import {
  creditUsdtDeposit,
  type Database,
  depositFlags,
  deposits,
  LedgerError,
  type PaymentReferenceOwner,
  queueDepositCard,
  queuePayWaiting,
  recordAudit,
  txidHolders,
  usdtDeposits,
  usdtTransferState,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import type { AdminIdentity } from '../admin/index.js';
import { AuthService } from '../auth/index.js';
import { isUuid, lockDeposit, notFound, stateConflict } from './deposit-records.js';
import { DepositReviewService } from './deposit-review.service.js';
import { verifyJob } from './usdt-deposits.service.js';
import { transferView, usdtCandidates } from './usdt-records.js';

/** Thrown inside the approval's transaction when its key decided first: answered as a replay. */
class AlreadyDecided extends Error {}

/**
 * The admin's side of USDT deposits (S04 rules U13, U15, U17): approving a review from its
 * transfer, re-sending a verification, and the list of the transfers seen on chain.
 */
@Injectable()
export class UsdtReviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly review: DepositReviewService,
    private readonly customers: AuthService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * `POST /api/admin/deposits/:id/approve-usdt` (rule U15): the received amount floored to whole
   * cents, every flag acknowledged, always after a re-authentication. `created` false on a replay.
   */
  async approve(
    admin: AdminIdentity,
    id: string,
    idempotencyKey: string,
    input: ApproveUsdtDeposit,
    meta: RequestMeta,
  ): Promise<{ deposit: AdminDeposit; created: boolean }> {
    const replayed = await this.replay(id, idempotencyKey, input);
    if (replayed) return { deposit: replayed, created: false };
    const [current] = isUuid(id)
      ? await this.db.select().from(deposits).where(eq(deposits.id, id))
      : [];
    if (!current) throw notFound();
    // The route is `@Sensitive()`: a re-authentication always (rule U15).
    try {
      const row = await this.db.transaction(async (tx) => {
        const deposit = await lockDeposit(tx, id);
        if (deposit.decisionIdempotencyKey === idempotencyKey) throw new AlreadyDecided();
        const [bound] = await tx
          .select({ checkStatus: usdtDeposits.checkStatus, transfer: usdtTransfers })
          .from(usdtDeposits)
          .leftJoin(usdtTransfers, eq(usdtTransfers.id, usdtDeposits.transferId))
          .where(eq(usdtDeposits.depositId, deposit.id));
        if (deposit.status !== 'submitted' || bound?.checkStatus !== 'review' || !bound.transfer) {
          throw stateConflict(deposit.status);
        }
        const flags = await tx
          .selectDistinct({ code: depositFlags.code })
          .from(depositFlags)
          .where(eq(depositFlags.depositId, deposit.id));
        const expected = flags.map((flag) => flag.code);
        if (!sameFlags(input.acknowledgedFlags, expected)) {
          throw new CodedException(409, 'FLAGS_NOT_ACKNOWLEDGED', 'Acknowledge every flag', {
            expected,
          });
        }
        const creditedUsdUnits = floorToWholeCents(bound.transfer.amountUnits);
        if (creditedUsdUnits <= 0) {
          throw new CodedException(400, 'VALIDATION_FAILED', 'The credit is below one cent', [
            { path: ['acknowledgedFlags'], message: 'Worth less than one cent' },
          ]);
        }
        try {
          // Under the transfer's network: a `wrong_network` credit posts from its receipts.
          const credited = await creditUsdtDeposit(tx, {
            depositId: deposit.id,
            transfer: {
              id: bound.transfer.id,
              method: bound.transfer.method as UsdtMethod,
              txid: bound.transfer.txid,
              amountUnits: bound.transfer.amountUnits,
            },
            creditedUsdUnits,
            decision: {
              by: 'admin',
              adminId: admin.id,
              idempotencyKey,
              acknowledgedFlags: expected,
              internalNote: input.internalNote ?? null,
              ipAddress: meta.ipAddress,
              userAgent: meta.userAgent,
            },
          });
          // The amount only; never the TXID, an address or a note (S01 email rule).
          await this.review.notify(tx, credited.deposit, 'deposit_credited', {
            depositId: credited.deposit.id,
            referenceCode: credited.deposit.referenceCode,
            creditedUsdUnits,
          });
          await queueDepositCard(tx, this.jobs, deposit.id);
          // A02 (S09 rule RS4): the customer's reservations are paid by the worker.
          await queuePayWaiting(tx, this.jobs, deposit.customerId);
          return credited.deposit;
        } catch (error) {
          if (error instanceof LedgerError && error.code === 'EXTERNAL_REFERENCE_TAKEN') {
            throw new CodedException(
              409,
              'EXTERNAL_REFERENCE_TAKEN',
              'The TXID is already recorded',
              (error.details as PaymentReferenceOwner | null) ?? undefined,
            );
          }
          throw error;
        }
      });
      return { deposit: await this.review.view(row), created: true };
    } catch (error) {
      if (error instanceof AlreadyDecided || isUniqueViolation(error)) {
        const again = await this.replay(id, idempotencyKey, input);
        if (again) return { deposit: again, created: false };
      }
      throw error;
    }
  }

  /**
   * `POST /api/admin/deposits/:id/recheck` (rule U17): sends the verification again, for example
   * after a reader outage. It changes nothing by itself.
   */
  async recheck(adminId: string, id: string, meta: RequestMeta): Promise<AdminDeposit> {
    const row = await this.db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id);
      if (deposit.method === 'sham_cash' || deposit.status !== 'submitted') {
        throw stateConflict(deposit.status);
      }
      await recordAudit(tx, {
        action: 'deposit.rechecked',
        actorKind: 'admin',
        actorId: adminId,
        channel: 'admin',
        entityType: 'deposit',
        entityId: deposit.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { depositId: deposit.id },
      });
      await this.jobs.send(tx, ...verifyJob(deposit.id));
      return deposit;
    });
    return this.review.view(row);
  }

  /** `GET /api/admin/usdt-transfers` (rule U13): newest first, unmatched by default. */
  async transfers(query: AdminUsdtTransferQuery): Promise<AdminUsdtTransferPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({
        transfer: usdtTransfers,
        state: usdtTransferState,
        at: cursorTime(usdtTransfers.blockTime),
      })
      .from(usdtTransfers)
      .where(
        and(
          query.method ? eq(usdtTransfers.method, query.method) : undefined,
          query.state === 'unmatched' ? eq(usdtTransferState, 'unmatched') : undefined,
          cursor ? after(usdtTransfers.blockTime, usdtTransfers.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(usdtTransfers.blockTime), desc(usdtTransfers.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ transfer, at }) => ({ at, id: transfer.id }));
    const holders = await this.holders(
      page.items.map(({ transfer, state }) => ({ transfer, state })),
    );
    const customers = await this.customers.depositCustomers([
      ...new Set([...holders.values()].map((holder) => holder.customerId)),
    ]);
    const items = await Promise.all(
      page.items.map(async ({ transfer, state }) => {
        const holder = holders.get(transfer.id);
        const customer = holder && customers.get(holder.customerId);
        return {
          ...transferView(transfer),
          state,
          holder:
            holder && customer
              ? {
                  kind: holder.kind,
                  id: holder.id,
                  customer: { id: customer.id, name: customer.name, email: customer.email },
                }
              : null,
          candidates:
            state === 'unmatched'
              ? await usdtCandidates(
                  this.db,
                  transfer.method as UsdtMethod,
                  transfer.amountUnits,
                  (ids) => this.customers.depositCustomers(ids),
                )
              : [],
        };
      }),
    );
    return { items, nextCursor: page.nextCursor };
  }

  /** Who holds each credited or bound transfer: the claim's owner, or the open deposit. */
  private async holders(
    items: { transfer: typeof usdtTransfers.$inferSelect; state: string }[],
  ): Promise<Map<string, { kind: 'deposit' | 'adjustment'; id: string; customerId: string }>> {
    const holders = new Map<
      string,
      { kind: 'deposit' | 'adjustment'; id: string; customerId: string }
    >();
    const credited = items.filter((item) => item.state === 'credited');
    for (const method of new Set(credited.map((item) => item.transfer.method as UsdtMethod))) {
      const ofMethod = credited.filter((item) => item.transfer.method === method);
      const claims = await txidHolders(
        this.db,
        method,
        ofMethod.map((item) => item.transfer.txid),
      );
      for (const item of ofMethod) {
        const claim = claims.get(item.transfer.txid);
        if (claim) holders.set(item.transfer.id, claim);
      }
    }
    const boundIds = items.filter((item) => item.state === 'bound').map((item) => item.transfer.id);
    if (boundIds.length > 0) {
      const bound = await this.db
        .select({
          transferId: usdtDeposits.transferId,
          depositId: usdtDeposits.depositId,
          customerId: deposits.customerId,
        })
        .from(usdtDeposits)
        .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
        .where(and(inArray(usdtDeposits.transferId, boundIds), eq(usdtDeposits.depositOpen, true)));
      for (const row of bound) {
        if (row.transferId) {
          holders.set(row.transferId, {
            kind: 'deposit',
            id: row.depositId,
            customerId: row.customerId,
          });
        }
      }
    }
    return holders;
  }

  /** The credited deposit of an earlier approval with this key, or null; another is refused. */
  private async replay(
    id: string,
    idempotencyKey: string,
    input: ApproveUsdtDeposit,
  ): Promise<AdminDeposit | null> {
    const [row] = await this.db
      .select()
      .from(deposits)
      .where(eq(deposits.decisionIdempotencyKey, idempotencyKey));
    if (!row) return null;
    const flags = await this.db
      .selectDistinct({ code: depositFlags.code })
      .from(depositFlags)
      .where(eq(depositFlags.depositId, row.id));
    const same =
      row.id === id &&
      row.status === 'credited' &&
      row.method !== 'sham_cash' &&
      sameFlags(
        input.acknowledgedFlags,
        flags.map((flag) => flag.code),
      );
    if (!same) {
      throw new CodedException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was used for another request',
      );
    }
    return this.review.view(row);
  }
}
