import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { USDT_NETWORKS, type UsdtMethod } from '@vertex-digital/contracts';
import { z } from 'zod';
import {
  type ChainReader,
  type ChainTransfer,
  type IncomingPage,
  sameAddress,
} from './chain-reader.js';

/*
 * The `fake` chain (S04, development and tests; refused in production by the environment check):
 * transactions written by `usdt:fake-transfer` (or a test) and read back as a reader would. In
 * development they live in a git-ignored JSON file (FAKE_CHAIN_FILE), never in a database, so no
 * fake transfer can exist where the live readers run. Tests use the in-memory store.
 */

const fakeTransactionSchema = z.object({
  method: z.enum(['usdt_trc20', 'usdt_bep20']),
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['succeeded', 'failed']),
  /** Increases with each transaction of a network: the scanner's cursor. */
  blockNumber: z.int().nonnegative(),
  blockTime: z.iso.datetime(),
  final: z.boolean(),
  transfers: z.array(
    z.object({
      contract: z.string(),
      from: z.string(),
      to: z.string(),
      raw: z.string().regex(/^\d+$/),
    }),
  ),
});

export type FakeTransaction = z.infer<typeof fakeTransactionSchema>;

export type NewFakeTransaction = Omit<FakeTransaction, 'blockNumber' | 'blockTime'> & {
  blockTime?: string;
};

export interface FakeChainStore {
  all(): Promise<FakeTransaction[]>;
  /** Adds a transaction (replacing one with the same network and TXID) and returns it. */
  add(transaction: NewFakeTransaction): Promise<FakeTransaction>;
}

function appended(list: FakeTransaction[], transaction: NewFakeTransaction): FakeTransaction {
  const sameNetwork = list.filter((item) => item.method === transaction.method);
  return fakeTransactionSchema.parse({
    ...transaction,
    blockNumber: Math.max(0, ...sameNetwork.map((item) => item.blockNumber)) + 1,
    blockTime: transaction.blockTime ?? new Date().toISOString(),
  });
}

const withReplaced = (list: FakeTransaction[], added: FakeTransaction) => [
  ...list.filter((item) => !(item.method === added.method && item.txid === added.txid)),
  added,
];

export class MemoryFakeChainStore implements FakeChainStore {
  private list: FakeTransaction[] = [];

  async all(): Promise<FakeTransaction[]> {
    return this.list;
  }

  async add(transaction: NewFakeTransaction): Promise<FakeTransaction> {
    const added = appended(this.list, transaction);
    this.list = withReplaced(this.list, added);
    return added;
  }
}

export class FileFakeChainStore implements FakeChainStore {
  constructor(private readonly path: string) {}

  async all(): Promise<FakeTransaction[]> {
    try {
      return z.array(fakeTransactionSchema).parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async add(transaction: NewFakeTransaction): Promise<FakeTransaction> {
    const list = await this.all();
    const added = appended(list, transaction);
    await mkdir(dirname(this.path), { recursive: true });
    // Written aside, then renamed: the worker never reads half a file.
    await writeFile(`${this.path}.tmp`, JSON.stringify(withReplaced(list, added), null, 2));
    await rename(`${this.path}.tmp`, this.path);
    return added;
  }
}

/** Reads one network of the fake chain. Final transactions show the required confirmations. */
export class FakeReader implements ChainReader {
  constructor(
    readonly method: UsdtMethod,
    private readonly store: FakeChainStore,
  ) {}

  async getTransfer(txid: string): Promise<ChainTransfer> {
    const found = (await this.store.all()).find(
      (item) => item.method === this.method && item.txid === txid,
    );
    if (!found) return { status: 'not_found' };
    if (found.status === 'failed') return { status: 'failed', final: found.final };
    return {
      status: 'succeeded',
      blockNumber: found.blockNumber,
      blockTime: new Date(found.blockTime),
      confirmations: found.final ? USDT_NETWORKS[this.method].confirmations : 1,
      final: found.final,
      transfers: found.transfers.map((transfer) => ({ ...transfer, raw: BigInt(transfer.raw) })),
    };
  }

  /** The cursor is the last block number read; the last block is read again (the overlap). */
  async listIncoming(address: string, cursor: string | null): Promise<IncomingPage> {
    const contract = USDT_NETWORKS[this.method].contract;
    const from = cursor === null ? 0 : Number(cursor);
    const sums = new Map<string, bigint>();
    let last = from;
    for (const item of await this.store.all()) {
      if (item.method !== this.method || item.blockNumber < from) continue;
      if (!item.final || item.status !== 'succeeded') continue;
      last = Math.max(last, item.blockNumber);
      for (const transfer of item.transfers) {
        if (!sameAddress(this.method, transfer.to, address)) continue;
        if (!sameAddress(this.method, transfer.contract, contract)) continue;
        sums.set(item.txid, (sums.get(item.txid) ?? 0n) + BigInt(transfer.raw));
      }
    }
    return {
      transfers: [...sums].map(([txid, raw]) => ({ txid, raw })),
      cursor: String(last),
      caughtUp: true,
    };
  }
}
