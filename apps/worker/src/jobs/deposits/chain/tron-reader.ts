import { tronAddressFromHex, USDT_NETWORKS } from '@vertex-digital/contracts';
import { z } from 'zod';
import { ChainHttp, type ChainHttpConfig } from './chain-http.js';
import {
  type ChainReader,
  ChainReaderError,
  type ChainTransfer,
  type IncomingPage,
  type IncomingTransfer,
  type TokenTransfer,
  TRANSFER_TOPIC,
} from './chain-reader.js';

const NETWORK = USDT_NETWORKS.usdt_trc20;

/** Rule U12: each read starts 2 minutes before the cursor (a block timestamp in ms). */
export const TRON_OVERLAP_MS = 2 * 60 * 1000;
/** The first read, with no cursor, looks back one hour. */
export const TRON_FIRST_LOOKBACK_MS = 60 * 60 * 1000;
/** TronGrid's page size limit, and the pages read per run before handing over to the next. */
const PAGE_SIZE = 200;
const PAGES_PER_RUN = 5;

const hex = z.string().regex(/^(?:0x)?[0-9a-fA-F]*$/);

/**
 * `/wallet[solidity]/gettransactioninfobyid`: `{}` when the node does not know the transaction.
 * `result: 'FAILED'` or a `receipt.result` other than `SUCCESS` is a failed contract call; a plain
 * TRX transfer has neither, and no logs.
 */
const transactionInfoSchema = z.union([
  z.looseObject({
    id: hex,
    blockNumber: z.int().nonnegative(),
    blockTimeStamp: z.int().positive(),
    result: z.string().optional(),
    receipt: z.looseObject({ result: z.string().optional() }).optional(),
    log: z
      .array(
        z.looseObject({
          address: hex.optional(),
          topics: z.array(hex).optional(),
          data: hex.optional(),
        }),
      )
      .optional(),
  }),
  z.strictObject({}),
]);

/** A transaction the node knows. */
type TransactionInfo = Extract<z.infer<typeof transactionInfoSchema>, { id: string }>;

const known = (info: z.infer<typeof transactionInfoSchema>): info is TransactionInfo =>
  'id' in info;

const nowBlockSchema = z.looseObject({
  block_header: z.looseObject({
    raw_data: z.looseObject({ number: z.int().nonnegative() }),
  }),
});

/** `/v1/accounts/<address>/transactions/trc20`: one item per TRC-20 transfer event. */
const trc20PageSchema = z.looseObject({
  success: z.literal(true),
  data: z.array(
    z.looseObject({
      transaction_id: hex,
      token_info: z.looseObject({ address: z.string() }),
      block_timestamp: z.int().positive(),
      from: z.string(),
      to: z.string(),
      type: z.string(),
      value: z.string().regex(/^\d+$/),
    }),
  ),
  meta: z.looseObject({ fingerprint: z.string().optional() }),
});

export interface TronReaderConfig extends Pick<ChainHttpConfig, 'fetch' | 'timeoutMs'> {
  apiUrl: string;
  apiKey?: string;
  /** The clock of the first read (tests). */
  now?: () => number;
}

/**
 * TRON through TronGrid (S04 rules U6, U12). A transaction is final when the solidity node
 * returns it (a solidified block, about 19 blocks); one only the full node knows is still
 * confirming, and its count comes from the latest block.
 */
export class TronReader implements ChainReader {
  readonly method = 'usdt_trc20' as const;
  private readonly http: ChainHttp;
  private readonly apiUrl: string;
  private readonly now: () => number;

  constructor(config: TronReaderConfig) {
    this.http = new ChainHttp({
      fetch: config.fetch,
      timeoutMs: config.timeoutMs,
      headers: config.apiKey ? { 'TRON-PRO-API-KEY': config.apiKey } : {},
    });
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.now = config.now ?? Date.now;
  }

  async getTransfer(txid: string): Promise<ChainTransfer> {
    const solid = await this.transactionInfo('walletsolidity', txid);
    if (known(solid)) return this.toTransfer(solid, true, NETWORK.confirmations);
    const seen = await this.transactionInfo('wallet', txid);
    if (!known(seen)) return { status: 'not_found' };
    const head = await this.http.request(`${this.apiUrl}/wallet/getnowblock`, nowBlockSchema, {
      method: 'POST',
      body: {},
      label: 'TronGrid getnowblock',
    });
    const confirmations = Math.max(0, head.block_header.raw_data.number - seen.blockNumber + 1);
    return this.toTransfer(seen, false, confirmations);
  }

  async listIncoming(address: string, cursor: string | null): Promise<IncomingPage> {
    const from =
      cursor === null ? this.now() - TRON_FIRST_LOOKBACK_MS : Number(cursor) - TRON_OVERLAP_MS;
    const contract = NETWORK.contract;
    const sums = new Map<string, bigint>();
    let latest = cursor === null ? from : Number(cursor);
    let fingerprint: string | undefined;
    for (let page = 0; page < PAGES_PER_RUN; page += 1) {
      const query = new URLSearchParams({
        only_confirmed: 'true',
        only_to: 'true',
        contract_address: contract,
        min_timestamp: String(Math.max(0, from)),
        order_by: 'block_timestamp,asc',
        limit: String(PAGE_SIZE),
        ...(fingerprint && { fingerprint }),
      });
      const result = await this.http.request(
        `${this.apiUrl}/v1/accounts/${address}/transactions/trc20?${query}`,
        trc20PageSchema,
        { method: 'GET', label: 'TronGrid trc20 transfers' },
      );
      for (const item of result.data) {
        latest = Math.max(latest, item.block_timestamp);
        // The query filters already; checked again, since only these may count.
        if (item.type !== 'Transfer' || item.to !== address) continue;
        if (item.token_info.address !== contract) continue;
        const txid = item.transaction_id.replace(/^0x/, '').toLowerCase();
        sums.set(txid, (sums.get(txid) ?? 0n) + BigInt(item.value));
      }
      fingerprint = result.meta.fingerprint;
      if (!fingerprint || result.data.length < PAGE_SIZE) {
        return { transfers: incoming(sums), cursor: String(latest), caughtUp: true };
      }
    }
    return { transfers: incoming(sums), cursor: String(latest), caughtUp: false };
  }

  private transactionInfo(node: 'wallet' | 'walletsolidity', txid: string) {
    return this.http.request(
      `${this.apiUrl}/${node}/gettransactioninfobyid`,
      transactionInfoSchema,
      { method: 'POST', body: { value: txid }, label: `TronGrid ${node} transaction` },
    );
  }

  private toTransfer(info: TransactionInfo, final: boolean, confirmations: number): ChainTransfer {
    const receipt = info.receipt?.result;
    if (info.result === 'FAILED' || (receipt !== undefined && receipt !== 'SUCCESS')) {
      return { status: 'failed', final };
    }
    return {
      status: 'succeeded',
      blockNumber: info.blockNumber,
      blockTime: new Date(info.blockTimeStamp),
      confirmations,
      final,
      transfers: (info.log ?? []).flatMap((log) => transferOf(log) ?? []),
    };
  }
}

/** A `Transfer` event log, or null for any other event. */
function transferOf(log: { address?: string; topics?: string[]; data?: string }) {
  const [topic, from, to] = (log.topics ?? []).map((value) =>
    value.replace(/^0x/, '').toLowerCase(),
  );
  if (topic !== TRANSFER_TOPIC || !from || !to || !log.address || !log.data) return null;
  const contract = tronAddressFromHex(log.address);
  const fromAddress = tronAddressFromHex(from.slice(-40));
  const toAddress = tronAddressFromHex(to.slice(-40));
  const data = log.data.replace(/^0x/, '');
  if (!contract || !fromAddress || !toAddress || data.length === 0) {
    throw new ChainReaderError('bad_response', 'TronGrid answered a malformed transfer log');
  }
  return {
    contract,
    from: fromAddress,
    to: toAddress,
    raw: BigInt(`0x${data}`),
  } satisfies TokenTransfer;
}

const incoming = (sums: Map<string, bigint>): IncomingTransfer[] =>
  [...sums].map(([txid, raw]) => ({ txid, raw }));
