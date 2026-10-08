import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type DepositsUsdtScanPayload,
  depositsUsdtScanPayloadSchema,
  QUEUES,
  rawToUsdUnits,
  USDT_DUST_THRESHOLD_UNITS,
  USDT_METHODS,
  USDT_NETWORKS,
  USDT_SCANNER_STALE_MINUTES,
  type UsdtMethod,
  usdtRawForUnits,
} from '@vertex-digital/contracts';
import {
  type Database,
  deposits,
  type Transaction,
  usdtDeposits,
  usdtScanCursors,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { TelegramAlerts } from '../../core/alerts/telegram-alerts.js';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import {
  CHAIN_READERS,
  ChainReaderError,
  type ChainReaders,
  type IncomingPage,
} from './chain/chain-reader.js';
import { type TransferFacts, usdtTransferTo } from './usdt-assess.js';
import { bindAndSettle, recordTransfer, txidClaimed } from './usdt-settle.js';

/** The safety-net schedule of every network (rule U12). */
export const USDT_SCAN_CRON = '*/5 * * * *';
/** The next scan while the network has an open USDT deposit, or has not caught up. */
export const USDT_SCAN_ACTIVE_SECONDS = 20;
/** A verification with no read for this long lost its chain of jobs: the scanner restarts it. */
export const VERIFY_LOST_MINUTES = 5;

export interface ScanResult {
  /** False when the network has no address, or a read failed (nothing moved). */
  scanned: boolean;
  recorded: number;
  credited: number;
  dust: number;
  caughtUp: boolean;
}

const NOT_SCANNED: ScanResult = {
  scanned: false,
  recorded: 0,
  credited: 0,
  dust: 0,
  caughtUp: false,
};

/**
 * `deposits.usdt-scan` (S04 rules U12–U14), per network (a `stately` queue keyed by the method):
 * reads the final official-USDT transfers to the store's address since the cursor, records each of
 * $1 or more once, and credits the one `pending` deposit that asked for exactly that amount (or a
 * deposit still searching a wrong TXID for it). The cursor moves only after the range's transfers
 * are committed; `last_success_at` only when the scan reached the chain's final head, so a
 * scanner behind keeps the network `delayed`. A stale scanner alerts once per window (A13).
 */
@Injectable()
export class UsdtScanJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(UsdtScanJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly alerts: TelegramAlerts,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(CHAIN_READERS) private readonly readers: ChainReaders,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<DepositsUsdtScanPayload>(QUEUES.depositsUsdtScan, async (data) => {
      await this.scan(depositsUsdtScanPayloadSchema.parse(data).method);
    });
    for (const method of USDT_METHODS) {
      await this.pgBoss.boss.schedule(
        QUEUES.depositsUsdtScan,
        USDT_SCAN_CRON,
        { method },
        { key: method, singletonKey: method },
      );
      // A first scan at once, so a started worker clears `delayed` without waiting.
      if (this.address(method)) await this.next(method, 0);
    }
    this.logger.log(`Scheduled ${QUEUES.depositsUsdtScan} (${USDT_SCAN_CRON} per network)`);
  }

  async scan(method: UsdtMethod): Promise<ScanResult> {
    const address = this.address(method);
    if (!address) return NOT_SCANNED;
    const [position] = await this.db
      .select({ cursor: usdtScanCursors.cursor })
      .from(usdtScanCursors)
      .where(eq(usdtScanCursors.method, method));
    let result = NOT_SCANNED;
    try {
      result = await this.read(method, address, position?.cursor ?? null);
    } catch (error) {
      if (!(error instanceof ChainReaderError)) throw error;
      this.logger.warn(`USDT scan of ${method} failed: ${error.message}`);
      await this.alerts.send(`USDT reader ${method} failing (${error.kind})`);
    }
    await this.alertIfStale(method);
    await this.restartLostVerifications(method);
    if (!result.caughtUp || (await this.hasOpenDeposit(method))) {
      await this.next(method, USDT_SCAN_ACTIVE_SECONDS);
    }
    return result;
  }

  private async read(method: UsdtMethod, address: string, cursor: string | null) {
    const reader = this.readers[method];
    const page: IncomingPage = await reader.listIncoming(address, cursor);
    const result: ScanResult = { ...NOT_SCANNED, scanned: true, caughtUp: page.caughtUp };
    const { decimals } = USDT_NETWORKS[method];
    for (const incoming of page.transfers) {
      // Rule U14: under $1 is address-poisoning spam, never recorded.
      if (rawToUsdUnits(incoming.raw, decimals) < USDT_DUST_THRESHOLD_UNITS) {
        result.dust += 1;
        continue;
      }
      const [known] = await this.db
        .select({ id: usdtTransfers.id })
        .from(usdtTransfers)
        .where(and(eq(usdtTransfers.method, method), eq(usdtTransfers.txid, incoming.txid)));
      if (known) continue;
      // The listing finds it; the transaction itself is the record (block, sum, finality).
      const read = await reader.getTransfer(incoming.txid);
      if (read.status === 'not_found' || !read.final) {
        // The listing ran ahead of the transaction's finality (BSC's `finalized` tag before 15
        // confirmations, a lagging node): not an outage. Stop here without moving the cursor;
        // the next scan, 20 seconds on, reads it again.
        this.logger.log(`USDT scan of ${method}: ${incoming.txid} not final yet`);
        return { ...result, caughtUp: false };
      }
      if (read.status === 'failed') {
        this.logger.warn(`USDT scan of ${method}: listed ${incoming.txid} reads failed`);
        continue;
      }
      const found = usdtTransferTo(method, incoming.txid, read, address);
      if ('error' in found) {
        result.dust += 1;
        continue;
      }
      const outcome = await this.db.transaction((tx) => this.settle(tx, found));
      if (outcome !== 'known') result.recorded += 1;
      if (outcome === 'credited') result.credited += 1;
    }
    await this.db
      .insert(usdtScanCursors)
      .values({
        method,
        cursor: page.cursor,
        // A first scan still behind is not a success yet.
        lastSuccessAt: page.caughtUp ? sql`now()` : sql`'epoch'::timestamptz`,
      })
      .onConflictDoUpdate({
        target: usdtScanCursors.method,
        set: {
          cursor: page.cursor,
          ...(page.caughtUp && { lastSuccessAt: sql`now()` }),
          updatedAt: sql`now()`,
        },
      });
    if (result.dust > 0) this.logger.log(`USDT scan of ${method}: ${result.dust} dust transfers`);
    if (result.recorded > 0) {
      this.logger.log(
        `USDT scan of ${method}: ${result.recorded} transfers, ${result.credited} credited`,
      );
    }
    return result;
  }

  /**
   * Records a scanned transfer and credits its deposit when exactly one asked for it (rule U12):
   * a `pending` deposit of that network and address with that exact amount, created before the
   * block and not expired at it; else a deposit searching another TXID for that amount (the
   * customer pasted a wrong one, edge case 7). Otherwise the transfer stays unmatched (rule U13).
   */
  private async settle(
    tx: Transaction,
    transfer: TransferFacts,
  ): Promise<'known' | 'unmatched' | 'credited'> {
    const { row, inserted } = await recordTransfer(tx, transfer, 'scan');
    // The verifier recorded it first: it binds it (edge case 6).
    if (!inserted) return 'known';
    // Claimed already, on either network (an S02 manual deposit during an outage): it stays
    // unmatched, so it is never credited twice and never blocks the scan.
    if (await txidClaimed(tx, transfer.txid)) return 'unmatched';
    const exactRaw = (units: number) =>
      usdtRawForUnits(units, USDT_NETWORKS[transfer.method].decimals) === transfer.raw;
    if (!exactRaw(transfer.amountUnits)) return 'unmatched';
    const matching = and(
      eq(usdtDeposits.method, transfer.method),
      eq(usdtDeposits.receivingAddress, transfer.toAddress),
      eq(usdtDeposits.payAmountUnits, transfer.amountUnits),
      isNull(usdtDeposits.transferId),
      lte(deposits.createdAt, transfer.blockTime),
    );
    const [waiting] = await tx
      .select({ deposit: deposits, payAmountUnits: usdtDeposits.payAmountUnits })
      .from(usdtDeposits)
      .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
      .where(
        and(matching, eq(deposits.status, 'pending'), gt(deposits.expiresAt, transfer.blockTime)),
      )
      .for('update', { of: deposits });
    if (waiting) {
      await tx
        .update(deposits)
        .set({ status: 'submitted', submittedAt: sql`now()` })
        .where(eq(deposits.id, waiting.deposit.id));
      return this.bind(tx, waiting.deposit.id, row, transfer, waiting.payAmountUnits);
    }
    const [searching] = await tx
      .select({ deposit: deposits, payAmountUnits: usdtDeposits.payAmountUnits })
      .from(usdtDeposits)
      .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
      .where(
        and(
          matching,
          eq(deposits.status, 'submitted'),
          inArray(usdtDeposits.checkStatus, ['searching', 'confirming']),
          ne(usdtDeposits.txid, transfer.txid),
        ),
      )
      .orderBy(deposits.createdAt)
      .limit(1)
      .for('update', { of: deposits });
    if (searching) {
      return this.bind(tx, searching.deposit.id, row, transfer, searching.payAmountUnits);
    }
    return 'unmatched';
  }

  private async bind(
    tx: Transaction,
    depositId: string,
    row: typeof usdtTransfers.$inferSelect,
    transfer: TransferFacts,
    payAmountUnits: number,
  ): Promise<'credited'> {
    const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, depositId));
    if (!deposit) throw new Error(`Deposit ${depositId} vanished`);
    await bindAndSettle(tx, this.pgBoss.boss, {
      deposit,
      transfer: row,
      flags: [],
      txidSource: 'scan',
      payAmountUnits,
      depositMethod: transfer.method,
    });
    return 'credited';
  }

  /** Rule U12: no complete scan for 10 minutes; one alert per window (repeats suppressed). */
  private async alertIfStale(method: UsdtMethod): Promise<void> {
    const [fresh] = await this.db
      .select({ method: usdtScanCursors.method })
      .from(usdtScanCursors)
      .where(
        and(
          eq(usdtScanCursors.method, method),
          sql`${usdtScanCursors.lastSuccessAt} > now() - make_interval(mins => ${USDT_SCANNER_STALE_MINUTES})`,
        ),
      );
    if (fresh) return;
    this.logger.warn(`USDT scanner ${method} is delayed`);
    await this.alerts.send(
      `USDT scanner ${method} delayed: no complete scan for ${USDT_SCANNER_STALE_MINUTES} minutes; new deposits wait`,
    );
  }

  /** A verification whose chain of jobs was lost (a crash between runs) is sent again. */
  private async restartLostVerifications(method: UsdtMethod): Promise<void> {
    const lost = await this.db
      .select({ depositId: usdtDeposits.depositId })
      .from(usdtDeposits)
      .where(
        and(
          eq(usdtDeposits.method, method),
          eq(usdtDeposits.depositOpen, true),
          inArray(usdtDeposits.checkStatus, ['searching', 'confirming']),
          sql`coalesce(${usdtDeposits.lastCheckedAt}, ${usdtDeposits.searchStartedAt}, ${usdtDeposits.updatedAt})
            < now() - make_interval(mins => ${VERIFY_LOST_MINUTES})`,
        ),
      );
    for (const { depositId } of lost) {
      await this.pgBoss.boss.send(
        QUEUES.depositsUsdtVerify,
        { depositId },
        { singletonKey: depositId, retryLimit: 5, retryBackoff: true },
      );
    }
  }

  private async hasOpenDeposit(method: UsdtMethod): Promise<boolean> {
    const [open] = await this.db
      .select({ depositId: usdtDeposits.depositId })
      .from(usdtDeposits)
      .where(and(eq(usdtDeposits.method, method), eq(usdtDeposits.depositOpen, true)))
      .limit(1);
    return open !== undefined;
  }

  private async next(method: UsdtMethod, seconds: number): Promise<void> {
    await this.pgBoss.boss.send(
      QUEUES.depositsUsdtScan,
      { method },
      { singletonKey: method, startAfter: seconds },
    );
  }

  private address(method: UsdtMethod): string | undefined {
    return method === 'usdt_trc20' ? this.env.USDT_TRC20_ADDRESS : this.env.USDT_BEP20_ADDRESS;
  }
}
