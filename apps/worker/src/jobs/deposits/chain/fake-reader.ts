import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { USDT_METHODS, USDT_NETWORKS, type UsdtMethod } from '@vertex-digital/contracts';
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
 * fake transfer can exist where the live readers run. Tests use the in-memory store. A network's
 * balance (S13) is its final transfers to and from the address plus a scripted offset: money moved
 * in or out outside the deposit flow (`usdt:fake-balance`).
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

const rawText = z.string().regex(/^-?\d+$/);

type Offsets = Partial<Record<UsdtMethod, string>>;

/** The file: the transactions and each network's balance offset in raw units (S13). */
const fakeChainFileSchema = z.union([
  // Before S13 the file held the transactions only.
  z
    .array(fakeTransactionSchema)
    .transform((transactions) => ({ transactions, offsets: {} as Offsets })),
  z.object({
    transactions: z.array(fakeTransactionSchema),
    offsets: z.partialRecord(z.enum(USDT_METHODS), rawText) as z.ZodType<Offsets>,
  }),
]);

type FakeChainFile = z.infer<typeof fakeChainFileSchema>;

export interface FakeChainStore {
  all(): Promise<FakeTransaction[]>;
  /** Adds a transaction (replacing one with the same network and TXID) and returns it. */
  add(transaction: NewFakeTransaction): Promise<FakeTransaction>;
  /** The network's scripted balance offset in raw units (0 when never set). */
  offset(method: UsdtMethod): Promise<bigint>;
  /** Adds `raw` to the network's offset, or sets it back to 0 (null); returns the new offset. */
  adjustOffset(method: UsdtMethod, raw: bigint | null): Promise<bigint>;
}

const adjusted = (offsets: FakeChainFile['offsets'], method: UsdtMethod, raw: bigint | null) =>
  raw === null ? 0n : BigInt(offsets[method] ?? '0') + raw;

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
  private offsets: FakeChainFile['offsets'] = {};

  async all(): Promise<FakeTransaction[]> {
    return this.list;
  }

  async add(transaction: NewFakeTransaction): Promise<FakeTransaction> {
    const added = appended(this.list, transaction);
    this.list = withReplaced(this.list, added);
    return added;
  }

  async offset(method: UsdtMethod): Promise<bigint> {
    return BigInt(this.offsets[method] ?? '0');
  }

  async adjustOffset(method: UsdtMethod, raw: bigint | null): Promise<bigint> {
    const next = adjusted(this.offsets, method, raw);
    this.offsets = { ...this.offsets, [method]: next.toString() };
    return next;
  }
}

export class FileFakeChainStore implements FakeChainStore {
  constructor(private readonly path: string) {}

  async all(): Promise<FakeTransaction[]> {
    return (await this.read()).transactions;
  }

  async add(transaction: NewFakeTransaction): Promise<FakeTransaction> {
    const file = await this.read();
    const added = appended(file.transactions, transaction);
    await this.write({ ...file, transactions: withReplaced(file.transactions, added) });
    return added;
  }

  async offset(method: UsdtMethod): Promise<bigint> {
    return BigInt((await this.read()).offsets[method] ?? '0');
  }

  async adjustOffset(method: UsdtMethod, raw: bigint | null): Promise<bigint> {
    const file = await this.read();
    const next = adjusted(file.offsets, method, raw);
    await this.write({ ...file, offsets: { ...file.offsets, [method]: next.toString() } });
    return next;
  }

  private async read(): Promise<FakeChainFile> {
    try {
      return fakeChainFileSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { transactions: [], offsets: {} };
      throw error;
    }
  }

  private async write(file: FakeChainFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Written aside, then renamed: the worker never reads half a file.
    await writeFile(`${this.path}.tmp`, JSON.stringify(file, null, 2));
    await rename(`${this.path}.tmp`, this.path);
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

  /**
   * The final official-USDT transfers to the address less those from it, plus the scripted
   * offset (S13).
   */
  async getUsdtBalance(address: string): Promise<bigint> {
    const contract = USDT_NETWORKS[this.method].contract;
    let raw = await this.store.offset(this.method);
    for (const item of await this.store.all()) {
      if (item.method !== this.method || !item.final || item.status !== 'succeeded') continue;
      for (const transfer of item.transfers) {
        if (!sameAddress(this.method, transfer.contract, contract)) continue;
        if (sameAddress(this.method, transfer.to, address)) raw += BigInt(transfer.raw);
        if (sameAddress(this.method, transfer.from, address)) raw -= BigInt(transfer.raw);
      }
    }
    return raw;
  }
}
