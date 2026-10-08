import { randomBytes, randomInt } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  QUEUES,
  tronAddressFromHex,
  USDT_NETWORKS,
  type UsdtMethod,
  usdtRawForUnits,
} from '@vertex-digital/contracts';
import {
  auditEntries,
  customers,
  type Database,
  depositFlags,
  deposits,
  emailOutbox,
  ledgerAccounts,
  ledgerJournals,
  ledgerPostings,
  newId,
  usdtDeposits,
  usdtScanCursors,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramAlerts } from '../src/core/alerts/telegram-alerts.js';
import { DATABASE } from '../src/core/database/database.module.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import {
  CHAIN_READERS,
  type ChainReader,
  ChainReaderError,
  type ChainReaders,
} from '../src/jobs/deposits/chain/chain-reader.js';
import {
  FakeReader,
  MemoryFakeChainStore,
  type NewFakeTransaction,
} from '../src/jobs/deposits/chain/fake-reader.js';
import { mismatchFlags, usdtTransferTo } from '../src/jobs/deposits/usdt-assess.js';
import { USDT_SCAN_ACTIVE_SECONDS, UsdtScanJob } from '../src/jobs/deposits/usdt-scan.job.js';
import {
  CONFIRMING_SECONDS,
  SEARCH_FAST_SECONDS,
  SEARCH_SLOW_SECONDS,
  UsdtVerifyJob,
} from '../src/jobs/deposits/usdt-verify.job.js';
import { WorkerModule } from '../src/worker.module.js';

/*
 * The USDT jobs (S04 rules U6–U14) against the test database, with the fake chain in memory and
 * pg-boss stubbed: the tests call the jobs and see every job they send, and no background run
 * races them. Deposits and ledger rows are never deleted, so they stay; each test uses new
 * customers, random amounts and this run's own store addresses.
 */

const USD = 1_000_000;
// This run's addresses: no other run's or the API tests' deposits share them.
const TRON = tronAddressFromHex(randomBytes(20).toString('hex')) as string;
const BSC = `0x${randomBytes(20).toString('hex')}`;
const ADDRESS: Record<UsdtMethod, string> = { usdt_trc20: TRON, usdt_bep20: BSC };
const SENDER: Record<UsdtMethod, string> = {
  usdt_trc20: tronAddressFromHex('11'.repeat(20)) as string,
  usdt_bep20: `0x${'11'.repeat(20)}`,
};

const store = new MemoryFakeChainStore();
/** The fake readers, which a test can make fail (rule U6). */
let failing = false;
const flaky = (method: UsdtMethod): ChainReader => {
  const fake = new FakeReader(method, store);
  const check = () => {
    if (failing) throw new ChainReaderError('timeout', `${method} timed out`);
  };
  return {
    method,
    getTransfer: async (txid) => {
      check();
      return fake.getTransfer(txid);
    },
    listIncoming: async (address, cursor) => {
      check();
      return fake.listIncoming(address, cursor);
    },
  };
};
const readers: ChainReaders = { usdt_trc20: flaky('usdt_trc20'), usdt_bep20: flaky('usdt_bep20') };

interface Sent {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}
const sent: Sent[] = [];
const pgBossStub = {
  work: async () => {},
  boss: {
    send: async (
      queue: string,
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      sent.push({ queue, data, options });
      return newId();
    },
    schedule: async () => {},
  },
};

let app: INestApplicationContext;
let db: Database;
let verify: UsdtVerifyJob;
let scan: UsdtScanJob;
let alerts: TelegramAlerts;

beforeAll(async () => {
  process.env.USDT_TRC20_ADDRESS = TRON;
  process.env.USDT_BEP20_ADDRESS = BSC;
  process.env.CHAIN_READER = 'fake';
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(CHAIN_READERS)
    .useValue(readers)
    .overrideProvider(PgBossService)
    .useValue(pgBossStub)
    .compile();
  app = await moduleRef.init();
  db = app.get<Database>(DATABASE);
  verify = app.get(UsdtVerifyJob);
  scan = app.get(UsdtScanJob);
  alerts = app.get(TelegramAlerts);
  // The fake chain of this run starts at block 1.
  for (const method of ['usdt_trc20', 'usdt_bep20'] as const) {
    await db
      .insert(usdtScanCursors)
      .values({ method, cursor: '0', lastSuccessAt: sql`now()` })
      .onConflictDoUpdate({ target: usdtScanCursors.method, set: { cursor: '0' } });
  }
});

afterAll(async () => {
  delete process.env.USDT_TRC20_ADDRESS;
  delete process.env.USDT_BEP20_ADDRESS;
  delete process.env.CHAIN_READER;
  await app.close();
});

beforeEach(() => {
  failing = false;
  sent.length = 0;
});

const txid = () => randomBytes(32).toString('hex');

/** A random free amount: whole dollars from $10 and a tail (rule U3). */
const amounts = () => {
  const declared = randomInt(10, 2_000_000) * USD;
  const tail = randomInt(1, 100) * 100;
  return { declared, tail, pay: declared + tail };
};

interface Seeded {
  id: string;
  customerId: string;
  method: UsdtMethod;
  declared: number;
  tail: number;
  pay: number;
}

/** A pending USDT deposit of a new customer; `expired` puts `expires_at` in the past. */
async function usdtDeposit(method: UsdtMethod = 'usdt_trc20', expired = false): Promise<Seeded> {
  const customerId = newId();
  await db.insert(customers).values({
    id: customerId,
    name: 'Test',
    email: `${customerId}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  const id = newId();
  const code = Array.from(
    { length: 5 },
    () => '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[randomInt(31)],
  ).join('');
  const { declared, tail, pay } = amounts();
  await db.insert(deposits).values({
    id,
    customerId,
    method,
    referenceCode: `VD-${code}`,
    currency: 'USD',
    declaredAmountUnits: declared,
    declaredUsdUnits: declared,
    expiresAt: expired ? sql`now() - interval '1 minute'` : sql`now() + interval '24 hours'`,
    idempotencyKey: newId(),
  });
  await db.insert(usdtDeposits).values({
    depositId: id,
    method,
    receivingAddress: ADDRESS[method],
    tailUnits: tail,
    payAmountUnits: pay,
  });
  return { id, customerId, method, declared, tail, pay };
}

/** The customer pasted `hash` (rule U8), `minutesAgo` minutes ago. */
async function submitted(deposit: Seeded, hash: string, minutesAgo = 0): Promise<void> {
  await db
    .update(usdtDeposits)
    .set({
      txid: hash,
      txidSource: 'customer',
      txidSubmissions: 1,
      searchStartedAt: sql`now() - make_interval(mins => ${minutesAgo})`,
      checkStatus: 'searching',
    })
    .where(eq(usdtDeposits.depositId, deposit.id));
  await db
    .update(deposits)
    .set({ status: 'submitted', submittedAt: sql`now()` })
    .where(eq(deposits.id, deposit.id));
}

/** A transaction on the fake chain: official USDT of `units` to the store by default. */
async function onChain(
  method: UsdtMethod,
  hash: string,
  transfers: { raw: bigint; to?: string; contract?: string }[],
  options: Partial<Pick<NewFakeTransaction, 'status' | 'final' | 'blockTime'>> = {},
) {
  await store.add({
    method,
    txid: hash,
    status: options.status ?? 'succeeded',
    final: options.final ?? true,
    blockTime: options.blockTime,
    transfers: transfers.map((transfer) => ({
      contract: transfer.contract ?? USDT_NETWORKS[method].contract,
      from: SENDER[method],
      to: transfer.to ?? ADDRESS[method],
      raw: transfer.raw.toString(),
    })),
  });
}

const raw = (method: UsdtMethod, units: number) =>
  usdtRawForUnits(units, USDT_NETWORKS[method].decimals);

async function state(id: string) {
  const [row] = await db
    .select({ deposit: deposits, usdt: usdtDeposits })
    .from(deposits)
    .innerJoin(usdtDeposits, eq(usdtDeposits.depositId, deposits.id))
    .where(eq(deposits.id, id));
  if (!row) throw new Error(`No deposit ${id}`);
  return row;
}

const actionsOf = async (id: string) =>
  (
    await db
      .select({ action: auditEntries.action })
      .from(auditEntries)
      .where(eq(auditEntries.entityId, id))
      .orderBy(auditEntries.occurredAt, auditEntries.id)
  ).map((entry) => entry.action);

const postingsOf = (id: string) =>
  db
    .select({ code: ledgerAccounts.code, amountUnits: ledgerPostings.amountUnits })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerPostings.accountId))
    .where(eq(ledgerJournals.idempotencyKey, `deposit:${id}`))
    .orderBy(ledgerPostings.position);

const creditEmails = async (customerId: string) =>
  db
    .select({ params: emailOutbox.params })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.customerId, customerId),
        eq(emailOutbox.template, 'customer_deposit_credited'),
      ),
    );

const verifySends = () => sent.filter((job) => job.queue === QUEUES.depositsUsdtVerify);

describe('the exact match (rule U7)', () => {
  it('credits the declared amount once, with the tail in deposit_rounding, the audit and the email', async () => {
    const deposit = await usdtDeposit();
    const hash = txid();
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', deposit.pay) }]);
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('credited');
    const { deposit: row, usdt } = await state(deposit.id);
    expect(row).toMatchObject({
      status: 'credited',
      decidedBy: 'system',
      adminId: null,
      transactionNumber: hash,
      receivedCurrency: 'USD',
      receivedAmountUnits: deposit.pay,
      creditedUsdUnits: deposit.declared,
    });
    expect(usdt).toMatchObject({ checkStatus: 'done', txid: hash, txidSource: 'customer' });
    expect(await postingsOf(deposit.id)).toEqual([
      { code: 'usdt_receipts:usdt_trc20', amountUnits: -deposit.pay },
      { code: `customer_wallet:${deposit.customerId}`, amountUnits: deposit.declared },
      { code: 'deposit_rounding:USD', amountUnits: deposit.tail },
    ]);
    expect(await actionsOf(deposit.id)).toEqual(['deposit.transfer_bound', 'deposit.credited']);
    const [bound] = await db
      .select()
      .from(auditEntries)
      .where(
        and(
          eq(auditEntries.entityId, deposit.id),
          eq(auditEntries.action, 'deposit.transfer_bound'),
        ),
      );
    expect(bound).toMatchObject({
      actorKind: 'system',
      channel: 'worker',
      details: expect.objectContaining({ source: 'customer', match: 'exact', flags: [] }),
    });
    const emails = await creditEmails(deposit.customerId);
    expect(emails).toHaveLength(1);
    // No TXID or address in the email.
    expect(JSON.stringify(emails[0]?.params)).not.toContain(hash);
    const [transfer] = await db.select().from(usdtTransfers).where(eq(usdtTransfers.txid, hash));
    expect(transfer).toMatchObject({ source: 'txid', amountUnits: deposit.pay, toAddress: TRON });
    // Safe twice: a second run finds nothing to do.
    expect(await verify.verify(deposit.id)).toBe('skipped');
    expect(await creditEmails(deposit.customerId)).toHaveLength(1);
  });

  it('waits for finality: TRON not solidified is confirming, re-read every 10 seconds', async () => {
    const deposit = await usdtDeposit();
    const hash = txid();
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', deposit.pay) }], { final: false });
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('confirming');
    expect((await state(deposit.id)).usdt).toMatchObject({
      checkStatus: 'confirming',
      confirmations: 1,
      transferId: null,
    });
    expect(verifySends()).toEqual([
      expect.objectContaining({
        data: { depositId: deposit.id, notFoundReads: 0 },
        options: expect.objectContaining({
          singletonKey: deposit.id,
          startAfter: CONFIRMING_SECONDS,
        }),
      }),
    ]);
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', deposit.pay) }]);
    expect(await verify.verify(deposit.id)).toBe('credited');
  });

  it('sums several USDT transfers of one transaction (edge case 9)', async () => {
    const deposit = await usdtDeposit('usdt_bep20');
    const hash = txid();
    const half = raw('usdt_bep20', deposit.pay) / 2n;
    await onChain('usdt_bep20', hash, [
      { raw: half },
      { raw: raw('usdt_bep20', deposit.pay) - half },
      { raw: 5n, to: `0x${'99'.repeat(20)}` },
    ]);
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('credited');
    expect(await postingsOf(deposit.id)).toContainEqual({
      code: 'usdt_receipts:usdt_bep20',
      amountUnits: -deposit.pay,
    });
  });
});

describe('bounces (rule U10)', () => {
  it.each([
    ['a failed transaction', 'tx_failed', { status: 'failed' as const }, []],
    ['no token to the store', 'not_to_store', {}, [{ to: 'elsewhere' }]],
    [
      'another token',
      'wrong_token',
      {},
      [{ contract: tronAddressFromHex('33'.repeat(20)) as string }],
    ],
    ['official USDT under $1', 'amount_too_small', {}, [{ units: 900_000 }]],
  ])('bounces %s back to pending with %s, audited', async (_, error, options, shapes) => {
    const deposit = await usdtDeposit();
    const hash = txid();
    const elsewhere = tronAddressFromHex('44'.repeat(20)) as string;
    await onChain(
      'usdt_trc20',
      hash,
      (shapes as { to?: string; contract?: string; units?: number }[]).map((shape) => ({
        raw: raw('usdt_trc20', shape.units ?? deposit.pay),
        to: shape.to === 'elsewhere' ? elsewhere : undefined,
        contract: shape.contract,
      })),
      options,
    );
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('bounced');
    const { deposit: row, usdt } = await state(deposit.id);
    expect(row.status).toBe('pending');
    expect(usdt).toMatchObject({
      checkStatus: 'awaiting_transfer',
      checkError: error,
      txid: null,
      txidSource: null,
      transferId: null,
      txidSubmissions: 1,
    });
    const [entry] = await db
      .select()
      .from(auditEntries)
      .where(
        and(eq(auditEntries.entityId, deposit.id), eq(auditEntries.action, 'deposit.txid_bounced')),
      );
    expect(entry?.details).toEqual({ depositId: deposit.id, txid: hash, error });
    // Nothing recorded under $1 (rule U14) or for no USDT at all.
    expect(await db.select().from(usdtTransfers).where(eq(usdtTransfers.txid, hash))).toEqual([]);
  });

  it('bounces a TXID another deposit holds as used, never retrying (PR 1 review)', async () => {
    const first = await usdtDeposit();
    const second = await usdtDeposit();
    const hash = txid();
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', first.pay) }]);
    // Both customers pasted it while searching: the first is credited, the second bounces.
    await submitted(first, hash);
    await submitted(second, hash);
    expect(await verify.verify(first.id)).toBe('credited');
    expect(await verify.verify(second.id)).toBe('bounced');
    expect((await state(second.id)).usdt.checkError).toBe('txid_used');
    expect(await postingsOf(second.id)).toEqual([]);
  });

  it('expires a bounced deposit past its expiry instead (S03 rule SC12)', async () => {
    const deposit = await usdtDeposit('usdt_trc20', true);
    const hash = txid();
    await onChain('usdt_trc20', hash, [], { status: 'failed' });
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('expired');
    const { deposit: row, usdt } = await state(deposit.id);
    expect(row.status).toBe('expired');
    expect(usdt).toMatchObject({ checkStatus: 'done', checkError: null, depositOpen: false });
    expect(await actionsOf(deposit.id)).toEqual(['deposit.txid_bounced', 'deposit.expired']);
  });
});

describe('a TXID not found (rules U6, U9)', () => {
  it('re-reads every 15 seconds for 5 minutes, then every minute, counting the reads', async () => {
    const fresh = await usdtDeposit();
    await submitted(fresh, txid());
    expect(await verify.verify(fresh.id, 3)).toBe('searching');
    const later = await usdtDeposit();
    await submitted(later, txid(), 6);
    expect(await verify.verify(later.id)).toBe('searching');
    expect(verifySends().map((job) => [job.data, job.options?.startAfter])).toEqual([
      [{ depositId: fresh.id, notFoundReads: 4 }, SEARCH_FAST_SECONDS],
      [{ depositId: later.id, notFoundReads: 1 }, SEARCH_SLOW_SECONDS],
    ]);
    expect((await state(fresh.id)).usdt.lastCheckedAt).not.toBeNull();
  });

  it('bounces only after 30 minutes and 10 successful reads', async () => {
    const deposit = await usdtDeposit();
    await submitted(deposit, txid(), 31);
    expect(await verify.verify(deposit.id, 8)).toBe('searching');
    expect(await verify.verify(deposit.id, 9)).toBe('bounced');
    expect((await state(deposit.id)).usdt.checkError).toBe('not_found');
    const early = await usdtDeposit();
    await submitted(early, txid(), 29);
    expect(await verify.verify(early.id, 50)).toBe('searching');
  });

  it('never takes a reader error for "not found": nothing changes, nothing is counted', async () => {
    const deposit = await usdtDeposit();
    const hash = txid();
    await submitted(deposit, hash, 40);
    const send = vi.spyOn(alerts, 'send');
    failing = true;
    expect(await verify.verify(deposit.id, 20)).toBe('reader_error');
    expect((await state(deposit.id)).deposit.status).toBe('submitted');
    expect((await state(deposit.id)).usdt).toMatchObject({ checkStatus: 'searching', txid: hash });
    expect(verifySends().map((job) => job.data)).toEqual([
      { depositId: deposit.id, notFoundReads: 20 },
    ]);
    expect(send).toHaveBeenCalledWith('USDT reader usdt_trc20 failing (timeout)');
    send.mockRestore();
  });
});

describe('review (rule U11)', () => {
  it('sends a different amount to review with amount_mismatch, the transfer bound', async () => {
    const deposit = await usdtDeposit();
    const hash = txid();
    const received = deposit.pay - USD;
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', received) }]);
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('review');
    const { deposit: row, usdt } = await state(deposit.id);
    expect(row.status).toBe('submitted');
    expect(usdt.checkStatus).toBe('review');
    expect(usdt.transferId).not.toBeNull();
    const flags = await db
      .select()
      .from(depositFlags)
      .where(eq(depositFlags.depositId, deposit.id));
    expect(flags).toEqual([
      expect.objectContaining({
        code: 'amount_mismatch',
        details: {
          declaredCurrency: 'USD',
          declaredAmountUnits: deposit.pay,
          receivedCurrency: 'USD',
          receivedAmountUnits: received,
        },
      }),
    ]);
    expect(await postingsOf(deposit.id)).toEqual([]);
  });

  it('flags a transfer sent before the deposit', async () => {
    const deposit = await usdtDeposit();
    const hash = txid();
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', deposit.pay) }], {
      blockTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('review');
    const flags = await db
      .select()
      .from(depositFlags)
      .where(eq(depositFlags.depositId, deposit.id));
    expect(flags.map((flag) => flag.code)).toEqual(['sent_before_deposit']);
  });

  it('finds a TXID on the other network after the search, to the store there: wrong_network', async () => {
    const deposit = await usdtDeposit('usdt_trc20');
    const hash = txid();
    await onChain('usdt_bep20', hash, [{ raw: raw('usdt_bep20', deposit.pay) }]);
    await submitted(deposit, hash, 31);
    expect(await verify.verify(deposit.id, 9)).toBe('review');
    const flags = await db
      .select()
      .from(depositFlags)
      .where(eq(depositFlags.depositId, deposit.id));
    expect(flags).toEqual([
      expect.objectContaining({
        code: 'wrong_network',
        details: { depositMethod: 'usdt_trc20', transferMethod: 'usdt_bep20' },
      }),
    ]);
    const [transfer] = await db.select().from(usdtTransfers).where(eq(usdtTransfers.txid, hash));
    expect(transfer).toMatchObject({ method: 'usdt_bep20', toAddress: BSC });
  });

  it('takes an 18-decimal remainder below a micro-unit as a mismatch', async () => {
    const deposit = await usdtDeposit('usdt_bep20');
    const hash = txid();
    await onChain('usdt_bep20', hash, [{ raw: raw('usdt_bep20', deposit.pay) + 1n }]);
    await submitted(deposit, hash);
    expect(await verify.verify(deposit.id)).toBe('review');
    const [transfer] = await db.select().from(usdtTransfers).where(eq(usdtTransfers.txid, hash));
    expect(transfer).toMatchObject({
      amountUnits: deposit.pay,
      rawAmount: (raw('usdt_bep20', deposit.pay) + 1n).toString(),
    });
  });
});

describe('the scanner (rules U12–U14)', () => {
  it('credits the one pending deposit of the exact amount without a TXID, and reads twice harmlessly', async () => {
    const deposit = await usdtDeposit();
    const hash = txid();
    await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', deposit.pay) }]);
    const result = await scan.scan('usdt_trc20');
    expect(result).toMatchObject({ scanned: true, caughtUp: true });
    expect(result.credited).toBeGreaterThanOrEqual(1);
    const { deposit: row, usdt } = await state(deposit.id);
    expect(row).toMatchObject({ status: 'credited', decidedBy: 'system' });
    expect(usdt).toMatchObject({ txid: hash, txidSource: 'scan', checkStatus: 'done' });
    expect(await creditEmails(deposit.customerId)).toHaveLength(1);
    // The overlap reads it again: one transfer row, nothing more (rule U12).
    const again = await scan.scan('usdt_trc20');
    expect(again.recorded).toBe(0);
    expect(await db.select().from(usdtTransfers).where(eq(usdtTransfers.txid, hash))).toHaveLength(
      1,
    );
    // The network stays fresh, and the next scan comes in 20 seconds while deposits are open.
    const [cursor] = await db
      .select({
        fresh: sql<boolean>`${usdtScanCursors.lastSuccessAt} > now() - interval '1 minute'`,
      })
      .from(usdtScanCursors)
      .where(eq(usdtScanCursors.method, 'usdt_trc20'));
    expect(cursor?.fresh).toBe(true);
    await usdtDeposit();
    await scan.scan('usdt_trc20');
    expect(sent.filter((job) => job.queue === QUEUES.depositsUsdtScan).at(-1)).toMatchObject({
      data: { method: 'usdt_trc20' },
      options: { singletonKey: 'usdt_trc20', startAfter: USDT_SCAN_ACTIVE_SECONDS },
    });
  });

  it('ignores dust, records a transfer with no deposit as unmatched, and never credits an expired one', async () => {
    const expired = await usdtDeposit('usdt_bep20', true);
    const dust = txid();
    const unmatched = txid();
    const late = txid();
    await onChain('usdt_bep20', dust, [{ raw: raw('usdt_bep20', 990_000) }]);
    await onChain('usdt_bep20', unmatched, [{ raw: raw('usdt_bep20', 7_123_400) }]);
    await onChain('usdt_bep20', late, [{ raw: raw('usdt_bep20', expired.pay) }]);
    const result = await scan.scan('usdt_bep20');
    expect(result.dust).toBeGreaterThanOrEqual(1);
    const recorded = await db
      .select({ txid: usdtTransfers.txid, source: usdtTransfers.source })
      .from(usdtTransfers)
      .where(sql`${usdtTransfers.txid} in (${dust}, ${unmatched}, ${late})`);
    expect(recorded.map((row) => row.txid).sort()).toEqual([late, unmatched].sort());
    expect(recorded.every((row) => row.source === 'scan')).toBe(true);
    // Past its expiry, the deposit is the transfer's candidate, never credited (edge case 5).
    expect((await state(expired.id)).deposit.status).toBe('pending');
  });

  it('replaces a wrong TXID the customer pasted with the exact transfer it found (edge case 7)', async () => {
    const deposit = await usdtDeposit();
    const wrong = txid();
    await submitted(deposit, wrong);
    const right = txid();
    await onChain('usdt_trc20', right, [{ raw: raw('usdt_trc20', deposit.pay) }]);
    await scan.scan('usdt_trc20');
    expect((await state(deposit.id)).usdt).toMatchObject({
      txid: right,
      txidSource: 'scan',
      checkStatus: 'done',
    });
    // The verifier of the wrong TXID then has nothing to do.
    expect(await verify.verify(deposit.id)).toBe('skipped');
  });

  it('credits once when the scanner and the verifier read the same transfer in parallel (edge case 6)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const deposit = await usdtDeposit();
      const hash = txid();
      await onChain('usdt_trc20', hash, [{ raw: raw('usdt_trc20', deposit.pay) }]);
      await submitted(deposit, hash);
      const outcomes = await Promise.allSettled([
        verify.verify(deposit.id),
        scan.scan('usdt_trc20'),
        verify.verify(deposit.id),
      ]);
      // A deadlock between the two is retried by pg-boss; the money is never doubled.
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled').length).toBeGreaterThan(
        0,
      );
      if ((await state(deposit.id)).deposit.status !== 'credited') {
        expect(await verify.verify(deposit.id)).toBe('credited');
      }
      const journals = await db
        .select()
        .from(ledgerJournals)
        .where(eq(ledgerJournals.idempotencyKey, `deposit:${deposit.id}`));
      expect(journals).toHaveLength(1);
      expect(
        (await actionsOf(deposit.id)).filter((action) => action === 'deposit.credited'),
      ).toHaveLength(1);
      expect(await creditEmails(deposit.customerId)).toHaveLength(1);
    }
  });

  it('keeps the cursor and alerts when a read fails, and alerts a stale network once per window', async () => {
    const send = vi.spyOn(alerts, 'send');
    const [before] = await db
      .select()
      .from(usdtScanCursors)
      .where(eq(usdtScanCursors.method, 'usdt_bep20'));
    failing = true;
    expect(await scan.scan('usdt_bep20')).toMatchObject({ scanned: false });
    const [after] = await db
      .select()
      .from(usdtScanCursors)
      .where(eq(usdtScanCursors.method, 'usdt_bep20'));
    expect(after?.cursor).toBe(before?.cursor);
    expect(send).toHaveBeenCalledWith('USDT reader usdt_bep20 failing (timeout)');
    // Stale: no complete scan for 10 minutes. Restored at once: other suites read this row.
    await db
      .update(usdtScanCursors)
      .set({ lastSuccessAt: sql`now() - interval '11 minutes'` })
      .where(eq(usdtScanCursors.method, 'usdt_bep20'));
    try {
      await scan.scan('usdt_bep20');
      await scan.scan('usdt_bep20');
    } finally {
      failing = false;
      await scan.scan('usdt_bep20');
    }
    const stale = send.mock.calls.filter(([text]) => text.includes('delayed'));
    // The same text each time: the alert channel sends it once per window.
    expect(new Set(stale.map(([text]) => text)).size).toBe(1);
    expect(stale[0]?.[0]).toBe(
      'USDT scanner usdt_bep20 delayed: no complete scan for 10 minutes; new deposits wait',
    );
    send.mockRestore();
  });

  it('restarts a verification whose chain of jobs was lost', async () => {
    const deposit = await usdtDeposit();
    await submitted(deposit, txid(), 20);
    await db
      .update(usdtDeposits)
      .set({ lastCheckedAt: sql`now() - interval '6 minutes'` })
      .where(eq(usdtDeposits.depositId, deposit.id));
    await scan.scan('usdt_trc20');
    expect(verifySends()).toContainEqual(
      expect.objectContaining({ data: { depositId: deposit.id } }),
    );
  });

  it('skips a network without an address', async () => {
    const saved = process.env.USDT_BEP20_ADDRESS;
    const job = new UsdtScanJob(
      pgBossStub as never,
      alerts,
      db,
      { USDT_TRC20_ADDRESS: undefined, USDT_BEP20_ADDRESS: undefined } as never,
      readers,
    );
    expect(await job.scan('usdt_trc20')).toMatchObject({ scanned: false });
    process.env.USDT_BEP20_ADDRESS = saved;
  });
});

describe('the assessment (rules U7, U10, U11)', () => {
  const read = (transfers: { contract: string; to: string; raw: bigint }[]) => ({
    status: 'succeeded' as const,
    blockNumber: 1,
    blockTime: new Date('2026-10-08T10:00:00Z'),
    confirmations: 19,
    final: true,
    transfers: transfers.map((transfer) => ({ ...transfer, from: SENDER.usdt_trc20 })),
  });
  const contract = USDT_NETWORKS.usdt_trc20.contract;

  it('matches exactly, or names every difference', () => {
    const found = usdtTransferTo(
      'usdt_trc20',
      'aa'.repeat(32),
      read([{ contract, to: TRON, raw: 25_003_700n }]),
      TRON,
    );
    if ('error' in found) throw new Error(found.error);
    const ask = {
      method: 'usdt_trc20' as const,
      payAmountUnits: 25_003_700,
      createdAt: new Date('2026-10-08T09:00:00Z'),
    };
    expect(mismatchFlags(found, ask)).toEqual([]);
    expect(
      mismatchFlags(found, {
        method: 'usdt_bep20',
        payAmountUnits: 25_003_600,
        createdAt: new Date('2026-10-08T11:00:00Z'),
      }),
    ).toEqual(['amount_mismatch', 'wrong_network', 'sent_before_deposit']);
  });
});
