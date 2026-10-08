import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateUsdtDeposit,
  DEPOSIT_PAUSE_SWITCHES,
  DEPOSIT_PENDING_HOURS,
  type Deposit,
  depositLimitBreach,
  depositLimitSettingsFor,
  depositMethodState,
  MAX_TXID_SUBMISSIONS,
  normalizeTxid,
  QUEUES,
  type SubmitTxid,
  TXID_SUBMISSIONS_PER_HOUR,
  USDT_METHODS,
  USDT_NETWORKS,
  USDT_TAIL_MAX_UNITS,
  USDT_TAIL_MIN_UNITS,
  USDT_TAIL_STEP_UNITS,
  type UsdtMethod,
  type UsdtOptions,
  usdtPayAmount,
} from '@vertex-digital/contracts';
import {
  type Database,
  deposits,
  paymentReferenceOwner,
  recordAudit,
  type Transaction,
  usdtDeposits,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, between, eq, ne, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { withinLimits } from '../auth/index.js';
import { SettingsService } from '../settings/index.js';
import {
  AlreadyCreated,
  checkCreation,
  checkNotStopped,
  customerEntry,
  insertDeposit,
  isOpen,
  limitsOf,
  lockCustomerCreations,
  lockDeposit,
  rateLimited,
  stateConflict,
} from './deposit-records.js';
import { DepositSettingsService } from './deposit-settings.service.js';
import { DepositsService } from './deposits.service.js';
import { usdtReserved } from './usdt-records.js';

const HOUR_MS = 60 * 60 * 1000;

/** Every tail of rule U3: 0.0001–0.0099 USDT in USD units. */
const TAILS = Array.from(
  { length: (USDT_TAIL_MAX_UNITS - USDT_TAIL_MIN_UNITS) / USDT_TAIL_STEP_UNITS + 1 },
  (_, index) => USDT_TAIL_MIN_UNITS + index * USDT_TAIL_STEP_UNITS,
);

/**
 * A scan of a network (rule U12): one at a time per network. A new deposit sends one, so the
 * worker starts watching at once and keeps a 20-second pace while the deposit is open.
 */
export const scanJob = (method: UsdtMethod) =>
  [QUEUES.depositsUsdtScan, { method }, { singletonKey: method }] as const;

/** The verification job of a deposit: one at a time per deposit (rule U9). */
export const verifyJob = (depositId: string) =>
  [QUEUES.depositsUsdtVerify, { depositId }, { singletonKey: depositId }] as const;

/**
 * The customer's USDT deposits (S04 rules U1–U5, U8): the networks' options, creation with the
 * exact amount, and the optional TXID. The rest of a deposit's life (list, read, cancel) is
 * `DepositsService`'s, as for Sham Cash.
 */
@Injectable()
export class UsdtDepositsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly settings: DepositSettingsService,
    private readonly deposits: DepositsService,
    private readonly jobs: JobsService,
    private readonly switches: SettingsService,
  ) {}

  /** `GET /api/deposits/usdt/options` (rules U1, U5). */
  async options(customerId: string): Promise<UsdtOptions> {
    const settings = await this.settings.current();
    const [networks, switches, [pending]] = await Promise.all([
      this.settings.usdtNetworks(settings),
      this.switches.values(),
      this.db
        .select({ id: deposits.id })
        .from(deposits)
        .where(and(eq(deposits.customerId, customerId), eq(deposits.status, 'pending'))),
    ]);
    return {
      networks: networks.map((network) => ({
        method: network.method,
        state: depositMethodState({
          stopped: switches.deposits_stopped,
          paused: switches[DEPOSIT_PAUSE_SWITCHES[network.method]],
          ready: network.unavailableReason === null,
        }),
        available: network.unavailableReason === null,
        unavailableReason: network.unavailableReason,
        address: network.unavailableReason === null ? network.address : null,
        confirmations: USDT_NETWORKS[network.method].confirmations,
      })),
      limits:
        settings &&
        (await limitsOf(this.db, customerId, depositLimitSettingsFor('usdt_trc20', settings))),
      pendingDepositId: pending?.id ?? null,
    };
  }

  /** `POST /api/deposits/usdt` (rules U2–U5): `created` false on a replay. */
  async create(
    customerId: string,
    idempotencyKey: string,
    input: CreateUsdtDeposit,
    meta: RequestMeta,
  ): Promise<{ deposit: Deposit; created: boolean }> {
    const replayed = await this.replay(customerId, idempotencyKey, input);
    if (replayed) return { deposit: replayed, created: false };

    const settings = await this.settings.current();
    const network = (await this.settings.usdtNetworks(settings)).find(
      (item) => item.method === input.method,
    );
    if (!settings || !network?.address || network.unavailableReason) {
      throw new CodedException(409, 'DEPOSIT_METHOD_UNAVAILABLE', 'Not available now', {
        method: input.method,
        reason: network?.unavailableReason ?? 'not_configured',
      });
    }
    const address = network.address;
    try {
      const row = await this.db.transaction(async (tx) => {
        await lockCustomerCreations(tx, customerId);
        const [written] = await tx
          .select({ id: deposits.id })
          .from(deposits)
          .where(eq(deposits.idempotencyKey, idempotencyKey));
        if (written) throw new AlreadyCreated();
        await checkNotStopped(this.switches, tx, input.method);
        await checkCreation(tx, customerId);
        const limits = await limitsOf(
          tx,
          customerId,
          depositLimitSettingsFor(input.method, settings),
        );
        const breach = depositLimitBreach(limits, input.amountUnits);
        if (breach) {
          throw new CodedException(422, 'DEPOSIT_LIMIT_EXCEEDED', 'Outside the limits', breach);
        }
        const tail = await this.freeTail(tx, input.method, input.amountUnits);
        const created = await insertDeposit(tx, {
          customerId,
          method: input.method,
          currency: 'USD',
          declaredAmountUnits: input.amountUnits,
          declaredUsdUnits: input.amountUnits,
          idempotencyKey,
          expiresAt: sql`now() + make_interval(hours => ${DEPOSIT_PENDING_HOURS})`,
        });
        const payAmountUnits = usdtPayAmount(input.amountUnits, tail);
        await tx.insert(usdtDeposits).values({
          depositId: created.id,
          method: input.method,
          receivingAddress: address,
          tailUnits: tail,
          payAmountUnits,
        });
        await recordAudit(tx, {
          ...customerEntry(customerId, created.id, meta),
          action: 'deposit.created',
          details: {
            depositId: created.id,
            method: created.method,
            currency: created.currency,
            declaredAmountUnits: created.declaredAmountUnits,
            declaredUsdUnits: created.declaredUsdUnits,
            rateId: null,
            payAmountUnits,
          },
        });
        await this.jobs.send(tx, ...scanJob(input.method));
        return created;
      });
      return { deposit: (await this.deposits.views([row], settings))[0] as Deposit, created: true };
    } catch (error) {
      if (error instanceof AlreadyCreated || isUniqueViolation(error)) {
        const again = await this.replay(customerId, idempotencyKey, input);
        if (again) return { deposit: again, created: false };
      }
      throw error;
    }
  }

  /**
   * `POST /api/deposits/:id/txid` (rule U8): starts the verification at once. Every attempt
   * counts toward the hourly limit, refused or not.
   */
  async submitTxid(
    customerId: string,
    id: string,
    input: SubmitTxid,
    meta: RequestMeta,
  ): Promise<Deposit> {
    const allowed = await withinLimits(this.db, [
      { key: `deposit-txid:${customerId}`, max: TXID_SUBMISSIONS_PER_HOUR, windowMs: HOUR_MS },
    ]);
    if (!allowed) throw rateLimited();
    const row = await this.db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id, eq(deposits.customerId, customerId));
      if (deposit.method === 'sham_cash' || deposit.status !== 'pending') {
        throw stateConflict(deposit.status);
      }
      if (!(await isOpen(tx, deposit))) throw stateConflict('expired');
      const txid = normalizeTxid(input.txid);
      if (!txid) {
        throw new CodedException(400, 'TXID_INVALID', 'Expected a TXID or an explorer link');
      }
      const [usdt] = await tx
        .select({ txidSubmissions: usdtDeposits.txidSubmissions })
        .from(usdtDeposits)
        .where(eq(usdtDeposits.depositId, deposit.id))
        .for('update');
      if (!usdt) throw new Error(`Deposit ${deposit.id} has no USDT row`);
      if (usdt.txidSubmissions >= MAX_TXID_SUBMISSIONS) {
        throw new CodedException(409, 'TXID_ATTEMPTS_EXCEEDED', 'Too many TXIDs for this deposit');
      }
      if (await this.txidTaken(tx, deposit.id, txid)) {
        // No details for the customer: whose it is stays the admin's to see.
        throw new CodedException(409, 'EXTERNAL_REFERENCE_TAKEN', 'The TXID is already used');
      }
      await tx
        .update(usdtDeposits)
        .set({
          txid,
          txidSource: 'customer',
          txidSubmissions: sql`${usdtDeposits.txidSubmissions} + 1`,
          searchStartedAt: sql`now()`,
          checkStatus: 'searching',
          checkError: null,
          confirmations: null,
        })
        .where(eq(usdtDeposits.depositId, deposit.id));
      const [updated] = await tx
        .update(deposits)
        .set({ status: 'submitted', submittedAt: sql`now()` })
        .where(eq(deposits.id, deposit.id))
        .returning();
      if (!updated) throw new Error(`Deposit ${deposit.id} was not submitted`);
      await recordAudit(tx, {
        ...customerEntry(customerId, deposit.id, meta),
        action: 'deposit.txid_submitted',
        details: { depositId: deposit.id, txid },
      });
      await this.jobs.send(tx, ...verifyJob(deposit.id));
      return updated;
    });
    return (await this.deposits.views([row]))[0] as Deposit;
  }

  /**
   * A random free tail for `amountUnits` on `method` (rule U3), under a lock per network so two
   * creations never pick the same one; the partial unique index is the backstop.
   */
  private async freeTail(tx: Transaction, method: UsdtMethod, amountUnits: number) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`usdt-tails:${method}`}))`);
    const taken = await tx
      .select({ payAmountUnits: usdtDeposits.payAmountUnits })
      .from(usdtDeposits)
      .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
      .where(
        and(
          eq(usdtDeposits.method, method),
          between(
            usdtDeposits.payAmountUnits,
            amountUnits + USDT_TAIL_MIN_UNITS,
            amountUnits + USDT_TAIL_MAX_UNITS,
          ),
          usdtReserved,
        ),
      );
    const reserved = new Set(taken.map((row) => row.payAmountUnits - amountUnits));
    const free = TAILS.filter((tail) => !reserved.has(tail));
    if (free.length === 0) {
      throw new CodedException(409, 'DEPOSIT_AMOUNT_BUSY', 'Every tail of this amount is taken');
    }
    return free[randomInt(free.length)] as number;
  }

  /**
   * True when `txid` is claimed on either network, or another USDT deposit holds it: bound to
   * its transfer, or being verified (rule U8).
   */
  private async txidTaken(tx: Transaction, depositId: string, txid: string): Promise<boolean> {
    for (const method of USDT_METHODS) {
      if (await paymentReferenceOwner(tx, method, txid)) return true;
    }
    const [other] = await tx
      .select({ depositId: usdtDeposits.depositId })
      .from(usdtDeposits)
      .leftJoin(usdtTransfers, eq(usdtTransfers.id, usdtDeposits.transferId))
      .where(
        and(
          ne(usdtDeposits.depositId, depositId),
          or(eq(usdtDeposits.txid, txid), eq(usdtTransfers.txid, txid)),
        ),
      )
      .limit(1);
    return other !== undefined;
  }

  /** The deposit of an earlier request with this key, or null; another body is refused. */
  private async replay(
    customerId: string,
    idempotencyKey: string,
    input: CreateUsdtDeposit,
  ): Promise<Deposit | null> {
    const [row] = await this.db
      .select()
      .from(deposits)
      .where(eq(deposits.idempotencyKey, idempotencyKey));
    if (!row) return null;
    if (
      row.customerId !== customerId ||
      row.method !== input.method ||
      row.declaredAmountUnits !== input.amountUnits
    ) {
      throw new CodedException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was used for another request',
      );
    }
    return (await this.deposits.views([row]))[0] as Deposit;
  }
}
