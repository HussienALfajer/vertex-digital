import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type DepositsUsdtVerifyPayload,
  depositsUsdtVerifyPayloadSchema,
  QUEUES,
  TXID_SEARCH_MINUTES,
  type UsdtCheckError,
  type UsdtMethod,
} from '@vertex-digital/contracts';
import { type Database, deposits, type Transaction, usdtDeposits } from '@vertex-digital/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TelegramAlerts } from '../../core/alerts/telegram-alerts.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import {
  CHAIN_READERS,
  ChainReaderError,
  type ChainReaders,
  type ChainTransfer,
} from './chain/chain-reader.js';
import { mismatchFlags, type TransferFacts, usdtTransferTo } from './usdt-assess.js';
import { bindAndSettle, bounce, recordTransfer, transferHeldElsewhere } from './usdt-settle.js';

/** Rule U9: a TXID not found is read every 15 seconds for 5 minutes, then every minute. */
export const SEARCH_FAST_SECONDS = 15;
export const SEARCH_FAST_FOR_SECONDS = 5 * 60;
export const SEARCH_SLOW_SECONDS = 60;
/** A transaction found and waiting for finality is read every 10 seconds. */
export const CONFIRMING_SECONDS = 10;
/** Rule U9: at least this many successful "not found" reads before a bounce. */
export const MIN_NOT_FOUND_READS = 10;

export type VerifyOutcome =
  | 'skipped'
  | 'searching'
  | 'confirming'
  | 'credited'
  | 'review'
  | 'bounced'
  | 'expired'
  | 'reader_error';

const OTHER: Record<UsdtMethod, UsdtMethod> = {
  usdt_trc20: 'usdt_bep20',
  usdt_bep20: 'usdt_trc20',
};

/** What the job reads of a deposit, with the database's clock (S03: time rules use `now()`). */
interface Checked {
  deposit: typeof deposits.$inferSelect;
  method: UsdtMethod;
  receivingAddress: string;
  payAmountUnits: number;
  txid: string;
  checkStatus: 'searching' | 'confirming';
  /** Seconds since `search_started_at`; null for a TXID the scanner gave. */
  searchSeconds: number | null;
}

/**
 * `deposits.usdt-verify` (S04 rules U6, U9–U11): reads one deposit's TXID and settles it. Sent by
 * the TXID submission, the admin's re-check, the scanner's sweep, and itself with `startAfter`
 * (a `stately` queue: one queued and one active per deposit). Safe to run twice and alongside the
 * scanner: every write locks the deposit and checks it still holds the TXID read, so a second run
 * is a no-op or finds the transfer already bound. A reader error concludes nothing: the next read
 * is scheduled and the alert channel told (repeats suppressed).
 */
@Injectable()
export class UsdtVerifyJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsdtVerifyJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly alerts: TelegramAlerts,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(CHAIN_READERS) private readonly readers: ChainReaders,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<DepositsUsdtVerifyPayload>(QUEUES.depositsUsdtVerify, async (data) => {
      const payload = depositsUsdtVerifyPayloadSchema.parse(data);
      await this.verify(payload.depositId, payload.notFoundReads ?? 0);
    });
    this.logger.log(`Working ${QUEUES.depositsUsdtVerify}`);
  }

  async verify(depositId: string, notFoundReads = 0): Promise<VerifyOutcome> {
    const checked = await this.load(depositId);
    if (!checked) return 'skipped';
    let read: ChainTransfer;
    try {
      read = await this.readers[checked.method].getTransfer(checked.txid);
    } catch (error) {
      return this.readerFailed(checked, error, notFoundReads);
    }
    if (read.status === 'not_found') return this.notFound(checked, notFoundReads + 1);
    if (!read.final) {
      await this.touch(checked, 'confirming', read.status === 'succeeded' ? read.confirmations : 0);
      await this.next(depositId, 0, CONFIRMING_SECONDS);
      return 'confirming';
    }
    if (read.status === 'failed') return this.settleBounce(checked, 'tx_failed');
    const found = usdtTransferTo(checked.method, checked.txid, read, checked.receivingAddress);
    if ('error' in found) return this.settleBounce(checked, found.error);
    return this.settleFound(checked, found);
  }

  private async load(depositId: string): Promise<Checked | null> {
    const [row] = await this.db
      .select({
        deposit: deposits,
        method: usdtDeposits.method,
        receivingAddress: usdtDeposits.receivingAddress,
        payAmountUnits: usdtDeposits.payAmountUnits,
        txid: usdtDeposits.txid,
        checkStatus: usdtDeposits.checkStatus,
        transferId: usdtDeposits.transferId,
        searchSeconds: sql<
          number | null
        >`extract(epoch from now() - ${usdtDeposits.searchStartedAt})::int`,
      })
      .from(usdtDeposits)
      .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
      .where(eq(usdtDeposits.depositId, depositId));
    if (
      row?.deposit.status !== 'submitted' ||
      !row.txid ||
      row.transferId !== null ||
      (row.checkStatus !== 'searching' && row.checkStatus !== 'confirming')
    ) {
      return null;
    }
    return {
      deposit: row.deposit,
      method: row.method as UsdtMethod,
      receivingAddress: row.receivingAddress,
      payAmountUnits: row.payAmountUnits,
      txid: row.txid,
      checkStatus: row.checkStatus,
      searchSeconds: row.searchSeconds,
    };
  }

  /**
   * Rule U9: not found yet. After 30 minutes of search and 10 successful "not found" reads, the
   * other network is read (rule U11: `wrong_network`), then the deposit bounces `not_found`.
   */
  private async notFound(checked: Checked, reads: number): Promise<VerifyOutcome> {
    const searched = checked.searchSeconds ?? 0;
    if (searched < TXID_SEARCH_MINUTES * 60 || reads < MIN_NOT_FOUND_READS) {
      await this.touch(checked, 'searching', null);
      await this.next(checked.deposit.id, reads, this.searchDelay(checked));
      return 'searching';
    }
    const other = OTHER[checked.method];
    const address = this.address(other);
    if (!address) return this.settleBounce(checked, 'not_found');
    let read: ChainTransfer;
    try {
      read = await this.readers[other].getTransfer(checked.txid);
    } catch (error) {
      return this.readerFailed(checked, error, reads);
    }
    if (read.status === 'not_found') return this.settleBounce(checked, 'not_found');
    if (!read.final) {
      await this.touch(checked, 'searching', null);
      await this.next(checked.deposit.id, reads, CONFIRMING_SECONDS);
      return 'searching';
    }
    if (read.status === 'failed') return this.settleBounce(checked, 'tx_failed');
    const found = usdtTransferTo(other, checked.txid, read, address);
    if ('error' in found) return this.settleBounce(checked, found.error);
    return this.settleFound(checked, found);
  }

  /** A final transfer of official USDT to the store: credit or review, once (rule U7, U11). */
  private async settleFound(checked: Checked, found: TransferFacts): Promise<VerifyOutcome> {
    const outcome = await this.db.transaction(async (tx) => {
      const deposit = await this.lockUnchanged(tx, checked);
      if (!deposit) return 'skipped' as const;
      const { row } = await recordTransfer(tx, found, 'txid');
      // Another deposit or an S02 adjustment holds it: final for this one (PR 1 review).
      if (await transferHeldElsewhere(tx, row, deposit.id)) {
        await bounce(tx, deposit, checked.txid, 'txid_used');
        return 'bounced' as const;
      }
      return bindAndSettle(tx, this.pgBoss.boss, {
        deposit,
        transfer: row,
        flags: mismatchFlags(found, {
          method: checked.method,
          payAmountUnits: checked.payAmountUnits,
          createdAt: deposit.createdAt,
        }),
        txidSource: (await this.txidSource(tx, deposit.id)) ?? 'customer',
        payAmountUnits: checked.payAmountUnits,
        depositMethod: checked.method,
      });
    });
    if (outcome !== 'skipped') this.logger.log(`USDT deposit ${checked.deposit.id}: ${outcome}`);
    return outcome;
  }

  private async settleBounce(checked: Checked, error: UsdtCheckError): Promise<VerifyOutcome> {
    const outcome = await this.db.transaction(async (tx) => {
      const deposit = await this.lockUnchanged(tx, checked);
      if (!deposit) return 'skipped' as const;
      return (await bounce(tx, deposit, checked.txid, error)) === 'expired'
        ? ('expired' as const)
        : ('bounced' as const);
    });
    if (outcome !== 'skipped') {
      this.logger.log(`USDT deposit ${checked.deposit.id}: TXID bounced (${error})`);
    }
    return outcome;
  }

  /** The deposit locked, if it still waits on the TXID that was read; else null (a no-op). */
  private async lockUnchanged(tx: Transaction, checked: Checked) {
    const [deposit] = await tx
      .select()
      .from(deposits)
      .where(eq(deposits.id, checked.deposit.id))
      .for('update');
    const [usdt] = await tx
      .select({
        txid: usdtDeposits.txid,
        checkStatus: usdtDeposits.checkStatus,
        transferId: usdtDeposits.transferId,
      })
      .from(usdtDeposits)
      .where(eq(usdtDeposits.depositId, checked.deposit.id));
    const waiting =
      deposit?.status === 'submitted' &&
      usdt?.txid === checked.txid &&
      usdt.transferId === null &&
      (usdt.checkStatus === 'searching' || usdt.checkStatus === 'confirming');
    return waiting ? deposit : null;
  }

  private async txidSource(tx: Transaction, depositId: string) {
    const [row] = await tx
      .select({ source: usdtDeposits.txidSource })
      .from(usdtDeposits)
      .where(eq(usdtDeposits.depositId, depositId));
    return row?.source ?? null;
  }

  /** Rule U6: nothing concluded; the next read is scheduled as if nothing happened. */
  private async readerFailed(
    checked: Checked,
    error: unknown,
    notFoundReads: number,
  ): Promise<VerifyOutcome> {
    if (!(error instanceof ChainReaderError)) throw error;
    this.logger.warn(`USDT read for deposit ${checked.deposit.id} failed: ${error.message}`);
    await this.alerts.send(`USDT reader ${checked.method} failing (${error.kind})`);
    await this.touch(checked, checked.checkStatus, undefined);
    await this.next(
      checked.deposit.id,
      notFoundReads,
      checked.checkStatus === 'confirming' ? CONFIRMING_SECONDS : this.searchDelay(checked),
    );
    return 'reader_error';
  }

  /** Records the read for the customer's page; only while the TXID is still the one read. */
  private async touch(
    checked: Checked,
    checkStatus: 'searching' | 'confirming',
    confirmations: number | null | undefined,
  ): Promise<void> {
    await this.db
      .update(usdtDeposits)
      .set({
        checkStatus,
        ...(confirmations !== undefined && { confirmations }),
        lastCheckedAt: sql`now()`,
      })
      .where(
        and(
          eq(usdtDeposits.depositId, checked.deposit.id),
          eq(usdtDeposits.txid, checked.txid),
          isNull(usdtDeposits.transferId),
          inArray(usdtDeposits.checkStatus, ['searching', 'confirming']),
        ),
      );
  }

  private searchDelay(checked: Checked): number {
    return (checked.searchSeconds ?? 0) < SEARCH_FAST_FOR_SECONDS
      ? SEARCH_FAST_SECONDS
      : SEARCH_SLOW_SECONDS;
  }

  private async next(depositId: string, notFoundReads: number, seconds: number): Promise<void> {
    await this.pgBoss.boss.send(
      QUEUES.depositsUsdtVerify,
      { depositId, notFoundReads },
      { singletonKey: depositId, startAfter: seconds, retryLimit: 5, retryBackoff: true },
    );
  }

  private address(method: UsdtMethod): string | undefined {
    return method === 'usdt_trc20' ? this.env.USDT_TRC20_ADDRESS : this.env.USDT_BEP20_ADDRESS;
  }
}
