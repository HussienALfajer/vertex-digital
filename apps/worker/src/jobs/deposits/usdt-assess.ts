import {
  type DepositFlagCode,
  rawToUsdUnits,
  USDT_DUST_THRESHOLD_UNITS,
  USDT_NETWORKS,
  type UsdtCheckError,
  type UsdtMethod,
  usdtRawForUnits,
} from '@vertex-digital/contracts';
import { type ChainTransfer, sameAddress } from './chain/chain-reader.js';

/** A final, official-USDT transfer to a store address, as `usdt_transfers` records it. */
export interface TransferFacts {
  method: UsdtMethod;
  txid: string;
  fromAddress: string;
  toAddress: string;
  raw: bigint;
  /** `raw` in USD units, floored. */
  amountUnits: number;
  blockNumber: number;
  blockTime: Date;
}

export type Succeeded = Extract<ChainTransfer, { status: 'succeeded' }>;

/**
 * The official-USDT part of a transaction to `address` on `method`, summed (edge case 9), or an
 * error: no token at all to the address (`not_to_store`), only other tokens (`wrong_token`, rule
 * U10), or less than $1 in all (`amount_too_small`: never recorded, rule U14).
 */
export function usdtTransferTo(
  method: UsdtMethod,
  txid: string,
  transaction: Succeeded,
  address: string,
): TransferFacts | { error: UsdtCheckError } {
  const network = USDT_NETWORKS[method];
  const toStore = transaction.transfers.filter((item) => sameAddress(method, item.to, address));
  const usdt = toStore.filter((item) => sameAddress(method, item.contract, network.contract));
  const [first] = usdt;
  if (!first) return { error: toStore.length > 0 ? 'wrong_token' : 'not_to_store' };
  const raw = usdt.reduce((sum, item) => sum + item.raw, 0n);
  const amountUnits = rawToUsdUnits(raw, network.decimals);
  if (amountUnits < USDT_DUST_THRESHOLD_UNITS) return { error: 'amount_too_small' };
  return {
    method,
    txid,
    fromAddress: first.from,
    toAddress: address,
    raw,
    amountUnits,
    blockNumber: transaction.blockNumber,
    blockTime: transaction.blockTime,
  };
}

/** What a USDT deposit asked for (rule U7). */
export interface DepositAsk {
  method: UsdtMethod;
  payAmountUnits: number;
  createdAt: Date;
}

/**
 * Why a transfer does not match its deposit exactly (rules U7, U11); none means an exact match:
 * the deposit's network, exactly `usdtRawForUnits(pay_amount_units)` raw (an 18-decimal remainder
 * below a micro-unit is a mismatch), sent at or after the deposit was created.
 */
export function mismatchFlags(transfer: TransferFacts, ask: DepositAsk): DepositFlagCode[] {
  const flags: DepositFlagCode[] = [];
  if (
    transfer.raw !== usdtRawForUnits(ask.payAmountUnits, USDT_NETWORKS[transfer.method].decimals)
  ) {
    flags.push('amount_mismatch');
  }
  if (transfer.method !== ask.method) flags.push('wrong_network');
  if (transfer.blockTime < ask.createdAt) flags.push('sent_before_deposit');
  return flags;
}
