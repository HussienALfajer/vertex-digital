import { USDT_NETWORKS } from '@vertex-digital/contracts';
import { z } from 'zod';
import { ChainHttp, type ChainHttpConfig } from './chain-http.js';
import {
  type ChainReader,
  ChainReaderError,
  type ChainTransfer,
  type IncomingPage,
  type TokenTransfer,
  TRANSFER_TOPIC,
} from './chain-reader.js';

const NETWORK = USDT_NETWORKS.usdt_bep20;
const CONTRACT = NETWORK.contract.toLowerCase();

/** Rule U12: each read starts 100 blocks before the cursor (the last block read). */
export const BSC_OVERLAP_BLOCKS = 100;
/** The first read, with no cursor, starts this many blocks before the finalized one. */
export const BSC_FIRST_LOOKBACK_BLOCKS = 5_000;
/**
 * Blocks per `eth_getLogs` call: within the range limit of the common providers (most allow
 * 1,000 to 10,000 blocks; filtered by contract and recipient, the result stays small), and ranges
 * read per run before handing over to the next.
 */
export const BSC_LOGS_RANGE = 1_000;
const RANGES_PER_RUN = 10;

const quantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .transform((value) => Number(BigInt(value)));
const data = z.string().regex(/^0x[0-9a-fA-F]*$/);

/** A JSON-RPC reply: `result` (which may be null), or `error`. */
const rpcReply = <T extends z.ZodType>(result: T) =>
  z
    .looseObject({
      result: result.optional(),
      error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
    })
    .refine((reply) => 'result' in reply || reply.error !== undefined);

const logSchema = z.looseObject({
  address: data,
  topics: z.array(data),
  data,
  transactionHash: data,
  removed: z.boolean().optional(),
});

const receiptSchema = z
  .looseObject({ status: quantity, blockNumber: quantity, logs: z.array(logSchema) })
  .nullable();

const blockSchema = z.looseObject({ number: quantity, timestamp: quantity }).nullable();

export interface BscReaderConfig extends Pick<ChainHttpConfig, 'fetch' | 'timeoutMs'> {
  /** The provider's JSON-RPC endpoint (its key, if any, is in the URL). */
  rpcUrl: string;
}

/**
 * BNB Smart Chain through a JSON-RPC provider (S04 rules U6, U12). A transaction is final when
 * its block is at or below the `finalized` block and has at least 15 confirmations.
 */
export class BscReader implements ChainReader {
  readonly method = 'usdt_bep20' as const;
  private readonly http: ChainHttp;
  private id = 0;

  constructor(private readonly config: BscReaderConfig) {
    this.http = new ChainHttp({ fetch: config.fetch, timeoutMs: config.timeoutMs });
  }

  async getTransfer(txid: string): Promise<ChainTransfer> {
    const receipt = await this.call('eth_getTransactionReceipt', [`0x${txid}`], receiptSchema);
    if (receipt === null) return { status: 'not_found' };
    const [block, finalized, latest] = [
      await this.block(`0x${receipt.blockNumber.toString(16)}`),
      await this.block('finalized'),
      await this.call('eth_blockNumber', [], quantity),
    ];
    const confirmations = Math.max(0, latest - receipt.blockNumber + 1);
    const final = receipt.blockNumber <= finalized.number && confirmations >= NETWORK.confirmations;
    if (receipt.status !== 1) return { status: 'failed', final };
    return {
      status: 'succeeded',
      blockNumber: receipt.blockNumber,
      blockTime: new Date(block.timestamp * 1000),
      confirmations,
      final,
      transfers: receipt.logs.flatMap((log) => transferOf(log) ?? []),
    };
  }

  async listIncoming(address: string, cursor: string | null): Promise<IncomingPage> {
    const finalized = (await this.block('finalized')).number;
    let from =
      cursor === null
        ? Math.max(0, finalized - BSC_FIRST_LOOKBACK_BLOCKS)
        : Math.max(0, Number(cursor) - BSC_OVERLAP_BLOCKS + 1);
    let last = cursor === null ? from - 1 : Number(cursor);
    const sums = new Map<string, bigint>();
    const recipient = `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
    for (let range = 0; range < RANGES_PER_RUN && from <= finalized; range += 1) {
      const to = Math.min(from + BSC_LOGS_RANGE - 1, finalized);
      const logs = await this.call(
        'eth_getLogs',
        [
          {
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            address: NETWORK.contract,
            topics: [`0x${TRANSFER_TOPIC}`, null, recipient],
          },
        ],
        z.array(logSchema),
      );
      for (const log of logs) {
        const transfer = transferOf(log);
        if (!transfer || transfer.contract !== CONTRACT) continue;
        if (transfer.to !== address.toLowerCase()) continue;
        const txid = log.transactionHash.slice(2).toLowerCase();
        sums.set(txid, (sums.get(txid) ?? 0n) + transfer.raw);
      }
      last = Math.max(last, to);
      from = to + 1;
    }
    return {
      transfers: [...sums].map(([txid, raw]) => ({ txid, raw })),
      cursor: String(Math.max(0, last)),
      caughtUp: last >= finalized,
    };
  }

  private async block(tag: string) {
    const block = await this.call('eth_getBlockByNumber', [tag, false], blockSchema);
    if (block === null) throw new ChainReaderError('bad_response', `BSC has no block ${tag}`);
    return block;
  }

  private async call<T>(method: string, params: unknown[], result: z.ZodType<T>): Promise<T> {
    this.id += 1;
    const reply = await this.http.request(this.config.rpcUrl, rpcReply(result), {
      method: 'POST',
      body: { jsonrpc: '2.0', id: this.id, method, params },
      label: `BSC ${method}`,
    });
    if (reply.error) {
      // -32005: the providers' "limit exceeded"; anything else is still no answer (rule U6).
      const kind = reply.error.code === -32005 ? 'rate_limited' : 'unavailable';
      throw new ChainReaderError(kind, `BSC ${method} answered error ${reply.error.code}`);
    }
    return reply.result as T;
  }
}

/** A `Transfer` event log, or null for any other event or a log a reorganization removed. */
function transferOf(log: z.infer<typeof logSchema>): TokenTransfer | null {
  const [topic, from, to] = log.topics.map((value) => value.slice(2).toLowerCase());
  if (log.removed || topic !== TRANSFER_TOPIC || !from || !to || log.data.length <= 2) return null;
  return {
    contract: log.address.toLowerCase(),
    from: `0x${from.slice(-40)}`,
    to: `0x${to.slice(-40)}`,
    raw: BigInt(log.data.slice(0, 66)),
  };
}
