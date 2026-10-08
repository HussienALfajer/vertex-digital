import type { UsdtMethod } from '@vertex-digital/contracts';

/*
 * The chain readers (S04 "Jobs and integrations", ADR 0006, 0018): one adapter per network behind
 * one interface, as the supplier adapters are. Readers are pure HTTP clients: no database, no Nest,
 * no `process.env`. Addresses come back in the network's own form: TRON base58 (`T…`), BSC
 * lower-case hex (`0x…`).
 */

/** One token `Transfer` event of a transaction. */
export interface TokenTransfer {
  /** The token contract that emitted the event. */
  contract: string;
  from: string;
  to: string;
  /** The amount in the token's raw units. */
  raw: bigint;
}

/**
 * A transaction as one successful read saw it (rule U6): never a guess. `final` is true once it
 * cannot be reverted: TRON solidified, BSC finalized with 15 confirmations.
 */
export type ChainTransfer =
  | { status: 'not_found' }
  | { status: 'failed'; final: boolean }
  | {
      status: 'succeeded';
      blockNumber: number;
      blockTime: Date;
      confirmations: number;
      final: boolean;
      transfers: TokenTransfer[];
    };

/** A transaction with official-USDT transfers to the watched address, their sum in raw units. */
export interface IncomingTransfer {
  txid: string;
  raw: bigint;
}

export interface IncomingPage {
  transfers: IncomingTransfer[];
  /** Where the next read starts (rule U12); stored as is in `usdt_scan_cursors`. */
  cursor: string;
  /** False while older final transfers remain to be read: the next run continues. */
  caughtUp: boolean;
}

export interface ChainReader {
  readonly method: UsdtMethod;
  /** The transaction `txid` (64 lower-case hex) and its token transfers. */
  getTransfer(txid: string): Promise<ChainTransfer>;
  /** Final official-USDT transfers to `address` from `cursor` on (null: the first read). */
  listIncoming(address: string, cursor: string | null): Promise<IncomingPage>;
}

export type ChainReaderErrorKind = 'timeout' | 'rate_limited' | 'unavailable' | 'bad_response';

/**
 * A read that did not give an answer (rule U6): a timeout, a refusal, an unreadable reply. It
 * never means "not found"; the job tries again later.
 */
export class ChainReaderError extends Error {
  override readonly name = 'ChainReaderError';

  constructor(
    readonly kind: ChainReaderErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Injection token: the reader of each network (`live` or `fake`, by `CHAIN_READER`). */
export const CHAIN_READERS = Symbol('CHAIN_READERS');

export type ChainReaders = Record<UsdtMethod, ChainReader>;

/** The ERC-20/TRC-20 `Transfer(address,address,uint256)` event topic. */
export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Two addresses of `method` are the same account: TRON base58 is exact, BSC hex is any case. */
export function sameAddress(method: UsdtMethod, a: string, b: string): boolean {
  return method === 'usdt_bep20' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
