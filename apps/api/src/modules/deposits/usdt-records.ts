import {
  type AdminDepositUsdt,
  type DepositUsdt,
  formatUsdtAmount,
  USD_CENT,
  USDT_NETWORKS,
  USDT_RESERVATION_GRACE_DAYS,
  USDT_REVIEW_FLAG_CODES,
  type UsdtCandidate,
  type UsdtMethod,
  type UsdtTransfer,
  type UsdtTransferState,
} from '@vertex-digital/contracts';
import {
  type Database,
  depositFlags,
  deposits,
  type Transaction,
  txidClaimed,
  usdtDeposits,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { DepositCustomer } from '../auth/index.js';

/*
 * What the USDT deposit views share (S04): each deposit's USDT row, its bound transfer and review
 * reasons, the customer's and the admin's blocks, and the candidate deposits of a transfer.
 */

export type UsdtRow = typeof usdtDeposits.$inferSelect;
export type TransferRow = typeof usdtTransfers.$inferSelect;

type ReviewReason = (typeof USDT_REVIEW_FLAG_CODES)[number];

export interface UsdtRecord {
  row: UsdtRow;
  transfer: TransferRow | null;
  reviewReasons: ReviewReason[];
}

/** The USDT records of `depositIds` (Sham Cash deposits have none). */
export async function usdtRecords(
  db: Database | Transaction,
  depositIds: readonly string[],
): Promise<Map<string, UsdtRecord>> {
  if (depositIds.length === 0) return new Map();
  const [rows, flags] = await Promise.all([
    db
      .select({ row: usdtDeposits, transfer: usdtTransfers })
      .from(usdtDeposits)
      .leftJoin(usdtTransfers, eq(usdtTransfers.id, usdtDeposits.transferId))
      .where(inArray(usdtDeposits.depositId, [...depositIds])),
    db
      .selectDistinct({ depositId: depositFlags.depositId, code: depositFlags.code })
      .from(depositFlags)
      .where(
        and(
          inArray(depositFlags.depositId, [...depositIds]),
          inArray(depositFlags.code, [...USDT_REVIEW_FLAG_CODES]),
        ),
      )
      .orderBy(depositFlags.code),
  ]);
  return new Map(
    rows.map(({ row, transfer }) => [
      row.depositId,
      {
        row,
        transfer,
        reviewReasons: flags
          .filter((flag) => flag.depositId === row.depositId)
          .map((flag) => flag.code as ReviewReason),
      },
    ]),
  );
}

/** A USDT deposit as its customer sees it; `delayed` is its network's scanner state (U12). */
export function customerUsdt(record: UsdtRecord, delayed: boolean): DepositUsdt {
  const { row, transfer } = record;
  const network = USDT_NETWORKS[(transfer?.method ?? row.method) as UsdtMethod];
  return {
    method: row.method as UsdtMethod,
    address: row.receivingAddress,
    payAmount: formatUsdtAmount(row.payAmountUnits),
    payAmountUnits: row.payAmountUnits,
    checkStatus: row.checkStatus,
    checkError: row.checkError,
    txid: row.txid,
    explorerUrl: row.txid && network.explorerTxUrl(row.txid),
    confirmations: row.confirmations,
    requiredConfirmations: USDT_NETWORKS[row.method as UsdtMethod].confirmations,
    delayed,
    receivedAmountUnits: transfer?.amountUnits ?? null,
    reviewReasons: row.checkStatus === 'review' ? record.reviewReasons : [],
  };
}

export function transferView(transfer: TransferRow): UsdtTransfer {
  return {
    id: transfer.id,
    method: transfer.method as UsdtMethod,
    txid: transfer.txid,
    explorerUrl: USDT_NETWORKS[transfer.method as UsdtMethod].explorerTxUrl(transfer.txid),
    fromAddress: transfer.fromAddress,
    toAddress: transfer.toAddress,
    rawAmount: transfer.rawAmount,
    amountUnits: transfer.amountUnits,
    blockNumber: transfer.blockNumber,
    blockTime: transfer.blockTime.toISOString(),
    source: transfer.source,
    createdAt: transfer.createdAt.toISOString(),
  };
}

/** The admin's block: the customer's view, the tail, the transfer and its candidates. */
export function adminUsdt(
  record: UsdtRecord,
  delayed: boolean,
  candidates: UsdtCandidate[],
): AdminDepositUsdt {
  return {
    ...customerUsdt(record, delayed),
    reviewReasons: record.reviewReasons,
    tailUnits: record.row.tailUnits,
    txidSource: record.row.txidSource,
    txidSubmissions: record.row.txidSubmissions,
    lastCheckedAt: record.row.lastCheckedAt?.toISOString() ?? null,
    transfer: record.transfer && transferView(record.transfer),
    candidates,
  };
}

/**
 * A USDT deposit whose amount is reserved (rules U3, U4): open, or closed (expired, cancelled,
 * credited or rejected) less than 7 days ago. A closed deposit's last change is its closing, so
 * `updated_at` dates it; an expired one is never closed before `expires_at`. Keeping credited
 * amounts reserved too means a customer's second payment of the same amount is never credited
 * to someone else's new deposit (edge case 3).
 */
export const usdtReserved = sql<boolean>`(${usdtDeposits.depositOpen}
  or greatest(${deposits.updatedAt}, ${deposits.expiresAt})
    > now() - make_interval(days => ${USDT_RESERVATION_GRACE_DAYS}))`;

/**
 * A recorded transfer's state (rule U13), for the lists and the badge: `credited` once its TXID is
 * claimed (by a deposit or an S02 manual deposit), `bound` while an open deposit holds it, else
 * `unmatched` (a rejected deposit leaves its transfer unmatched: its owner can still be credited).
 * Written with qualified names: it is used in select lists, where Drizzle drops table names.
 */
export const transferState = sql<UsdtTransferState>`case
  when ${txidClaimed(sql`usdt_transfers.method`, sql`usdt_transfers.txid`)} then 'credited'
  when exists (select 1 from usdt_deposits as bound
    where bound.transfer_id = usdt_transfers.id and bound.deposit_open) then 'bound'
  else 'unmatched' end`;

/** At most this many candidates per transfer. */
const CANDIDATE_LIMIT = 10;

export async function usdtCandidates(
  db: Database | Transaction,
  method: UsdtMethod,
  amountUnits: number,
  customersOf: (ids: string[]) => Promise<Map<string, DepositCustomer>>,
  exceptId?: string,
): Promise<UsdtCandidate[]> {
  const tail = amountUnits % USD_CENT;
  const rows = await db
    .select({
      depositId: deposits.id,
      customerId: deposits.customerId,
      referenceCode: deposits.referenceCode,
      status: deposits.status,
      payAmountUnits: usdtDeposits.payAmountUnits,
      createdAt: deposits.createdAt,
    })
    .from(usdtDeposits)
    .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
    .where(
      and(
        eq(usdtDeposits.method, method),
        or(
          eq(usdtDeposits.payAmountUnits, amountUnits),
          tail > 0 ? eq(usdtDeposits.tailUnits, tail) : undefined,
        ),
        usdtReserved,
        exceptId ? ne(deposits.id, exceptId) : undefined,
      ),
    )
    .orderBy(
      // The exact amount first, then the newest.
      desc(sql`${usdtDeposits.payAmountUnits} = ${amountUnits}`),
      desc(deposits.createdAt),
    )
    .limit(CANDIDATE_LIMIT);
  const customers = await customersOf([...new Set(rows.map((row) => row.customerId))]);
  return rows.map((row) => {
    const customer = customers.get(row.customerId);
    if (!customer) throw new Error(`Deposit ${row.depositId} has no customer`);
    return {
      depositId: row.depositId,
      referenceCode: row.referenceCode,
      status: row.status,
      payAmountUnits: row.payAmountUnits,
      createdAt: row.createdAt.toISOString(),
      customer: { id: customer.id, name: customer.name, email: customer.email },
    };
  });
}
