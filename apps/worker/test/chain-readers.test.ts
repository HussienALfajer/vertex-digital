import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tronAddressFromHex, USDT_NETWORKS } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import {
  BSC_FIRST_LOOKBACK_BLOCKS,
  BSC_LOGS_RANGE,
  BSC_OVERLAP_BLOCKS,
  BscReader,
} from '../src/jobs/deposits/chain/bsc-reader.js';
import { ChainReaderError } from '../src/jobs/deposits/chain/chain-reader.js';
import { FakeReader, MemoryFakeChainStore } from '../src/jobs/deposits/chain/fake-reader.js';
import {
  TRON_FIRST_LOOKBACK_MS,
  TRON_OVERLAP_MS,
  TronReader,
} from '../src/jobs/deposits/chain/tron-reader.js';

/*
 * The chain readers (S04 rules U6, U12) against the fixtures in
 * `src/jobs/deposits/chain/fixtures` (synthetic, see its README) through a scripted `fetch`:
 * nothing here reaches a chain.
 */

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../src/jobs/deposits/chain/fixtures', name), 'utf8'),
  );

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

/** A `fetch` answering each call with `answer(call)`: a body, a status, or a thrown error. */
function scripted(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const reply = answer(call);
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const timeout = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

const STORE_TRON = tronAddressFromHex('22'.repeat(20)) as string;
const SENDER_TRON = tronAddressFromHex('11'.repeat(20)) as string;
const STORE_BSC = `0x${'ab'.repeat(20)}`;
const TXID = '11'.repeat(32);

describe('TRON reader (TronGrid)', () => {
  const reader = (answer: (call: Call) => unknown, now = 1_759_900_000_000) => {
    const { fetchFn, calls } = scripted(answer);
    return {
      calls,
      reader: new TronReader({
        apiUrl: 'https://trongrid.test/',
        apiKey: 'test-key',
        fetch: fetchFn,
        now: () => now,
      }),
    };
  };

  it('reads a solidified transaction as final, with every Transfer log in base58', async () => {
    const { reader: tron, calls } = reader(() => fixture('tron-transaction-info.json'));
    const read = await tron.getTransfer(TXID);
    expect(read).toEqual({
      status: 'succeeded',
      blockNumber: 60_000_000,
      blockTime: new Date(1_759_900_000_000),
      confirmations: USDT_NETWORKS.usdt_trc20.confirmations,
      final: true,
      transfers: [
        {
          contract: USDT_NETWORKS.usdt_trc20.contract,
          from: SENDER_TRON,
          to: STORE_TRON,
          raw: 25_003_700n,
        },
        {
          contract: USDT_NETWORKS.usdt_trc20.contract,
          from: SENDER_TRON,
          to: STORE_TRON,
          raw: 1_000_000n,
        },
        {
          contract: tronAddressFromHex('33'.repeat(20)),
          from: SENDER_TRON,
          to: STORE_TRON,
          raw: 7_000_000n,
        },
      ],
    });
    expect(calls).toEqual([
      {
        url: 'https://trongrid.test/walletsolidity/gettransactioninfobyid',
        body: { value: TXID },
        headers: expect.objectContaining({ 'TRON-PRO-API-KEY': 'test-key' }),
      },
    ]);
  });

  it('reads a transaction only the full node knows as confirming, counted from the latest block', async () => {
    const { reader: tron, calls } = reader((call) =>
      call.url.includes('walletsolidity')
        ? {}
        : call.url.endsWith('getnowblock')
          ? fixture('tron-now-block.json')
          : fixture('tron-transaction-info.json'),
    );
    expect(await tron.getTransfer(TXID)).toMatchObject({
      status: 'succeeded',
      final: false,
      confirmations: 11,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/walletsolidity/gettransactioninfobyid',
      '/wallet/gettransactioninfobyid',
      '/wallet/getnowblock',
    ]);
  });

  it('says not found only when both nodes answer an empty object', async () => {
    const { reader: tron } = reader(() => ({}));
    expect(await tron.getTransfer(TXID)).toEqual({ status: 'not_found' });
  });

  it('reads a reverted contract call as failed, and a plain TRX transfer as no token', async () => {
    const failed = reader(() => fixture('tron-transaction-info-failed.json')).reader;
    expect(await failed.getTransfer(TXID)).toEqual({ status: 'failed', final: true });
    const trx = reader(() => fixture('tron-transaction-info-trx.json')).reader;
    expect(await trx.getTransfer(TXID)).toMatchObject({ status: 'succeeded', transfers: [] });
  });

  it.each([
    ['a timeout', () => timeout(), 'timeout'],
    ['a lost connection', () => new TypeError('fetch failed'), 'unavailable'],
    ['429', () => new Response('{}', { status: 429 }), 'rate_limited'],
    ['500', () => new Response('{}', { status: 500 }), 'unavailable'],
    ['no JSON', () => new Response('<html>', { status: 200 }), 'bad_response'],
    ['an unexpected shape', () => ({ id: 42 }), 'bad_response'],
    [
      'a malformed log',
      () => ({
        id: TXID,
        blockNumber: 1,
        blockTimeStamp: 1,
        log: [{ address: 'zz', topics: [`${'0'.repeat(56)}ddf252ad`], data: '01' }],
      }),
      'bad_response',
    ],
  ])('turns %s into a ChainReaderError, never "not found" (rule U6)', async (_, answer, kind) => {
    const { reader: tron } = reader(answer);
    const error = await tron.getTransfer(TXID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainReaderError);
    expect((error as ChainReaderError).kind).toBe(kind);
  });

  it('throws a malformed Transfer log as a bad response', async () => {
    const info = fixture('tron-transaction-info.json') as { log: { data: string }[] };
    const { reader: tron } = reader(() => ({
      ...info,
      log: [{ ...info.log[0], address: 'not-hex-at-all-but-matching'.replace(/./g, 'a') }],
    }));
    await expect(tron.getTransfer(TXID)).rejects.toBeInstanceOf(ChainReaderError);
  });

  it('lists confirmed USDT to the address since the cursor less the overlap, summed per transaction', async () => {
    const { reader: tron, calls } = reader(() => fixture('tron-trc20-transfers.json'));
    const cursor = 1_759_900_050_000;
    const page = await tron.listIncoming(STORE_TRON, String(cursor));
    expect(page).toEqual({
      transfers: [
        { txid: '44'.repeat(32), raw: 15_000_000n },
        // Dust is listed; the scanner ignores it (rule U14).
        { txid: '66'.repeat(32), raw: 100n },
      ],
      cursor: '1759900300000',
      caughtUp: true,
    });
    const query = new URL(calls[0]?.url as string);
    expect(query.pathname).toBe(`/v1/accounts/${STORE_TRON}/transactions/trc20`);
    expect(Object.fromEntries(query.searchParams)).toEqual({
      only_confirmed: 'true',
      only_to: 'true',
      contract_address: USDT_NETWORKS.usdt_trc20.contract,
      min_timestamp: String(cursor - TRON_OVERLAP_MS),
      order_by: 'block_timestamp,asc',
      limit: '200',
    });
  });

  it('looks back an hour on the first read, and follows the fingerprint up to five pages', async () => {
    const now = 1_759_900_500_000;
    const full = {
      success: true,
      data: Array.from({ length: 200 }, (_, index) => ({
        transaction_id: index.toString(16).padStart(64, '0'),
        token_info: { address: USDT_NETWORKS.usdt_trc20.contract },
        block_timestamp: now - 1000 + index,
        from: SENDER_TRON,
        to: STORE_TRON,
        type: 'Transfer',
        value: '2000000',
      })),
      meta: { fingerprint: 'next-page' },
    };
    const { reader: tron, calls } = reader(() => full, now);
    const page = await tron.listIncoming(STORE_TRON, null);
    expect(page.caughtUp).toBe(false);
    expect(page.cursor).toBe(String(now - 1000 + 199));
    expect(calls).toHaveLength(5);
    expect(new URL(calls[0]?.url as string).searchParams.get('min_timestamp')).toBe(
      String(now - TRON_FIRST_LOOKBACK_MS),
    );
    expect(new URL(calls[1]?.url as string).searchParams.get('fingerprint')).toBe('next-page');
    // An empty first read keeps the starting point as the cursor.
    const empty = reader(() => ({ success: true, data: [], meta: {} }), now).reader;
    expect(await empty.listIncoming(STORE_TRON, null)).toEqual({
      transfers: [],
      cursor: String(now - TRON_FIRST_LOOKBACK_MS),
      caughtUp: true,
    });
  });
});

describe('BSC reader (JSON-RPC)', () => {
  const BLOCK = 0x3b9aca0;

  /** A provider at `latest`, finalized at `finalized`, answering the fixtures. */
  const provider = (latest: number, finalized: number, extra?: (call: Call) => unknown) =>
    scripted((call) => {
      const special = extra?.(call);
      if (special !== undefined) return special;
      const { method, params } = call.body as { method: string; params: unknown[] };
      const hex = (value: number) => `0x${value.toString(16)}`;
      if (method === 'eth_getTransactionReceipt') return fixture('bsc-receipt.json');
      if (method === 'eth_blockNumber') return { jsonrpc: '2.0', id: 1, result: hex(latest) };
      if (method === 'eth_getBlockByNumber') {
        const block = fixture('bsc-block.json') as { result: Record<string, string> };
        return params[0] === 'finalized'
          ? { ...block, result: { ...block.result, number: hex(finalized) } }
          : block;
      }
      if (method === 'eth_getLogs') return fixture('bsc-logs.json');
      throw new Error(`Unexpected ${method}`);
    });

  it('reads a receipt as final once finalized with 15 confirmations, every Transfer log in lower case', async () => {
    const { fetchFn, calls } = provider(BLOCK + 14, BLOCK);
    const bsc = new BscReader({ rpcUrl: 'https://bsc.test/key', fetch: fetchFn });
    expect(await bsc.getTransfer('77'.repeat(32))).toEqual({
      status: 'succeeded',
      blockNumber: BLOCK,
      blockTime: new Date(0x68e5a000 * 1000),
      confirmations: 15,
      final: true,
      transfers: [
        {
          contract: USDT_NETWORKS.usdt_bep20.contract.toLowerCase(),
          from: `0x${'11'.repeat(20)}`,
          to: STORE_BSC,
          raw: 25_003_700_000_000_000_000n,
        },
        {
          contract: USDT_NETWORKS.usdt_bep20.contract.toLowerCase(),
          from: `0x${'11'.repeat(20)}`,
          to: STORE_BSC,
          raw: 1n,
        },
        {
          contract: `0x${'33'.repeat(20)}`,
          from: `0x${'11'.repeat(20)}`,
          to: STORE_BSC,
          raw: 5n * 10n ** 18n,
        },
      ],
    });
    expect(calls[0]).toMatchObject({
      url: 'https://bsc.test/key',
      body: {
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [`0x${'77'.repeat(32)}`],
      },
    });
  });

  it('is not final below 15 confirmations, nor above the finalized block', async () => {
    const few = new BscReader({
      rpcUrl: 'https://bsc.test',
      fetch: provider(BLOCK + 13, BLOCK).fetchFn,
    });
    expect(await few.getTransfer(TXID)).toMatchObject({ final: false, confirmations: 14 });
    const unfinalized = new BscReader({
      rpcUrl: 'https://bsc.test',
      fetch: provider(BLOCK + 40, BLOCK - 1).fetchFn,
    });
    expect(await unfinalized.getTransfer(TXID)).toMatchObject({ final: false, confirmations: 41 });
  });

  it('says not found for a null receipt, and failed for status 0', async () => {
    const missing = provider(BLOCK, BLOCK, (call) =>
      (call.body as { method: string }).method === 'eth_getTransactionReceipt'
        ? { jsonrpc: '2.0', id: 1, result: null }
        : undefined,
    );
    expect(
      await new BscReader({ rpcUrl: 'https://bsc.test', fetch: missing.fetchFn }).getTransfer(TXID),
    ).toEqual({ status: 'not_found' });
    const reverted = provider(BLOCK + 20, BLOCK + 20, (call) => {
      if ((call.body as { method: string }).method !== 'eth_getTransactionReceipt')
        return undefined;
      const receipt = fixture('bsc-receipt.json') as { result: Record<string, unknown> };
      return { ...receipt, result: { ...receipt.result, status: '0x0' } };
    });
    expect(
      await new BscReader({ rpcUrl: 'https://bsc.test', fetch: reverted.fetchFn }).getTransfer(
        TXID,
      ),
    ).toEqual({ status: 'failed', final: true });
  });

  it.each([
    [{ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }, 'rate_limited'],
    [
      { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } },
      'unavailable',
    ],
    [{ jsonrpc: '2.0', id: 1 }, 'bad_response'],
    [{ jsonrpc: '2.0', id: 1, result: '42' }, 'bad_response'],
  ])('turns %j into a ChainReaderError (rule U6)', async (reply, kind) => {
    const bsc = new BscReader({ rpcUrl: 'https://bsc.test', fetch: scripted(() => reply).fetchFn });
    const error = await bsc.getTransfer(TXID).catch((caught: unknown) => caught);
    expect((error as ChainReaderError).kind).toBe(kind);
  });

  it('refuses a missing block as a bad response', async () => {
    const { fetchFn } = provider(BLOCK + 20, BLOCK + 20, (call) =>
      (call.body as { method: string }).method === 'eth_getBlockByNumber'
        ? { jsonrpc: '2.0', id: 1, result: null }
        : undefined,
    );
    const error = await new BscReader({ rpcUrl: 'https://bsc.test', fetch: fetchFn })
      .getTransfer(TXID)
      .catch((caught: unknown) => caught);
    expect((error as ChainReaderError).kind).toBe('bad_response');
  });

  it('lists USDT logs to the address up to the finalized block, summed, from the cursor less the overlap', async () => {
    const finalized = 50_000;
    const { fetchFn, calls } = provider(finalized + 20, finalized);
    const bsc = new BscReader({ rpcUrl: 'https://bsc.test', fetch: fetchFn });
    const page = await bsc.listIncoming(STORE_BSC.toUpperCase().replace('0X', '0x'), '49900');
    expect(page).toEqual({
      // A log a reorganization removed is not counted.
      transfers: [{ txid: '88'.repeat(32), raw: 12n * 10n ** 18n }],
      cursor: String(finalized),
      caughtUp: true,
    });
    const logs = calls.find((call) => (call.body as { method: string }).method === 'eth_getLogs');
    expect((logs?.body as { params: unknown[] } | undefined)?.params).toEqual([
      {
        fromBlock: `0x${(49_900 - BSC_OVERLAP_BLOCKS + 1).toString(16)}`,
        toBlock: `0x${finalized.toString(16)}`,
        address: USDT_NETWORKS.usdt_bep20.contract,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          null,
          `0x${'0'.repeat(24)}${'ab'.repeat(20)}`,
        ],
      },
    ]);
  });

  it('reads at most ten ranges a run, and starts 5,000 blocks back on the first read', async () => {
    const finalized = 1_000_000;
    const { fetchFn, calls } = provider(finalized + 14, finalized, (call) =>
      (call.body as { method: string }).method === 'eth_getLogs'
        ? { jsonrpc: '2.0', id: 1, result: [] }
        : undefined,
    );
    const bsc = new BscReader({ rpcUrl: 'https://bsc.test', fetch: fetchFn });
    const behind = await bsc.listIncoming(STORE_BSC, '100');
    expect(behind).toEqual({
      transfers: [],
      cursor: String(100 - BSC_OVERLAP_BLOCKS + 10 * BSC_LOGS_RANGE),
      caughtUp: false,
    });
    const first = await bsc.listIncoming(STORE_BSC, null);
    expect(first.caughtUp).toBe(true);
    const ranges = calls
      .filter((call) => (call.body as { method: string }).method === 'eth_getLogs')
      .slice(10)
      .map((call) => (call.body as { params: { fromBlock: string }[] }).params[0]?.fromBlock);
    expect(ranges[0]).toBe(`0x${(finalized - BSC_FIRST_LOOKBACK_BLOCKS).toString(16)}`);
    // A cursor already at the head reads nothing and stays.
    expect(await bsc.listIncoming(STORE_BSC, String(finalized + BSC_OVERLAP_BLOCKS))).toEqual({
      transfers: [],
      cursor: String(finalized + BSC_OVERLAP_BLOCKS),
      caughtUp: true,
    });
  });
});

describe('BSC listing finality', () => {
  it('lists only up to the block with 15 confirmations when the finalized tag runs ahead', async () => {
    const { fetchFn } = scripted((call) => {
      const { method } = call.body as { method: string };
      if (method === 'eth_blockNumber') return { jsonrpc: '2.0', id: 1, result: '0x3e8' };
      if (method === 'eth_getBlockByNumber') {
        return { jsonrpc: '2.0', id: 1, result: { number: '0x3e6', timestamp: '0x1' } };
      }
      return { jsonrpc: '2.0', id: 1, result: [] };
    });
    const bsc = new BscReader({ rpcUrl: 'https://bsc.test', fetch: fetchFn });
    // Latest 1000, finalized 998: final means 15 confirmations, so block 986 at most.
    expect(await bsc.listIncoming(`0x${'ab'.repeat(20)}`, '900')).toMatchObject({
      cursor: '986',
      caughtUp: true,
    });
  });
});

describe('fake reader', () => {
  it('reads what the store holds, per network, with the cursor as a block number', async () => {
    const store = new MemoryFakeChainStore();
    const address = `0x${'ab'.repeat(20)}`;
    const contract = USDT_NETWORKS.usdt_bep20.contract;
    const transfer = (raw: string, to = address) => ({ contract, from: address, to, raw });
    const first = await store.add({
      method: 'usdt_bep20',
      txid: 'aa'.repeat(32),
      status: 'succeeded',
      final: true,
      transfers: [transfer('1'), transfer('2', address.toUpperCase().replace('0X', '0x'))],
    });
    await store.add({
      method: 'usdt_bep20',
      txid: 'bb'.repeat(32),
      status: 'failed',
      final: true,
      transfers: [],
    });
    await store.add({
      method: 'usdt_bep20',
      txid: 'cc'.repeat(32),
      status: 'succeeded',
      final: false,
      transfers: [transfer('5')],
    });
    await store.add({
      method: 'usdt_trc20',
      txid: 'dd'.repeat(32),
      status: 'succeeded',
      final: true,
      transfers: [],
    });
    const reader = new FakeReader('usdt_bep20', store);
    expect(first.blockNumber).toBe(1);
    expect(await reader.getTransfer('aa'.repeat(32))).toMatchObject({
      status: 'succeeded',
      final: true,
      confirmations: 15,
    });
    expect(await reader.getTransfer('bb'.repeat(32))).toEqual({ status: 'failed', final: true });
    expect(await reader.getTransfer('cc'.repeat(32))).toMatchObject({
      final: false,
      confirmations: 1,
    });
    expect(await reader.getTransfer('dd'.repeat(32))).toEqual({ status: 'not_found' });
    expect(await reader.listIncoming(address, null)).toEqual({
      transfers: [{ txid: 'aa'.repeat(32), raw: 3n }],
      cursor: '1',
      caughtUp: true,
    });
    expect((await reader.listIncoming(address, '2')).transfers).toEqual([]);
  });
});
