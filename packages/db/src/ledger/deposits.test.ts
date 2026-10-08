import { randomBytes } from 'node:crypto';
import { CURRENCY_SCALE, DEPOSIT_SETTINGS_DEFAULTS } from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import {
  customers,
  depositFlags,
  depositReceipts,
  depositSettings,
  deposits,
  exchangeRates,
  ledgerAccounts,
  ledgerPostings,
  storedFiles,
  usdtDeposits,
  usdtTransfers,
} from '../schema/index.js';
import { accountBalance } from './balance.js';
import { postDepositCredit, postUsdtDepositCredit } from './deposits.js';
import { LedgerError } from './errors.js';
import { claimPaymentReference, paymentReferenceOwner } from './payment-references.js';
import { findCustomerWallet, walletTimeline } from './wallet.js';

/*
 * Deposits in the database (S03): the deposit guard, the checks, one pending deposit per
 * customer, the append-only settings, receipts, flags and files, and the credit journals (money
 * flows M1–M3). Rows written here stay in the test database; every test uses new customers.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;

afterAll(() => Promise.all([connection.close(), owner.close()]));

const USD = CURRENCY_SCALE.USD;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const referenceCode = () =>
  `VD-${Array.from(randomBytes(5), (byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;

async function customer(): Promise<string> {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Test',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  return id;
}

async function rate(sypPerUsd = '118'): Promise<string> {
  const id = newId();
  await db
    .insert(exchangeRates)
    .values({ id, sypPerUsd, displayStepSypUnits: 500, adminId: newId() });
  return id;
}

type DepositRow = typeof deposits.$inferInsert;

/** A pending USD deposit of $10 (or SYP with a quote), with any field overridden. */
async function deposit(values: Partial<DepositRow> & { customerId: string }): Promise<string> {
  const id = newId();
  const syp = values.currency === 'SYP';
  await db.insert(deposits).values({
    id,
    method: 'sham_cash',
    referenceCode: referenceCode(),
    currency: 'USD',
    declaredAmountUnits: 10 * USD,
    declaredUsdUnits: 10 * USD,
    expiresAt: sql`now() + interval '24 hours'`,
    idempotencyKey: newId(),
    ...(syp
      ? {
          declaredAmountUnits: 200_000,
          declaredUsdUnits: 16_940_000,
          rateId: await rate(),
          rate: '118',
          quoteExpiresAt: sql`now() + interval '15 minutes'`,
        }
      : {}),
    ...values,
  });
  return id;
}

const submitted = { status: 'submitted', submittedAt: new Date() } as const;

async function file(): Promise<string> {
  const id = newId();
  await db.insert(storedFiles).values({
    id,
    kind: 'deposit_receipt',
    storageKey: `deposit_receipt/${id.slice(-2)}/${id}.webp`,
    contentType: 'image/webp',
    byteSize: 1000,
    width: 100,
    height: 200,
  });
  return id;
}

/** The Postgres error message of a refused statement, through Drizzle's wrapper. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error('Expected the statement to be refused');
}

describe('the deposit guard', () => {
  it('lets a deposit move along the transition table', async () => {
    const id = await deposit({ customerId: await customer() });
    await db.update(deposits).set(submitted).where(eq(deposits.id, id));
    await db
      .update(deposits)
      .set({
        status: 'pending',
        receiptRequestCount: 1,
        receiptRequestedAt: sql`now()`,
        receiptRequestNote: 'Clearer, please',
      })
      .where(eq(deposits.id, id));
    await db.update(deposits).set({ status: 'cancelled' }).where(eq(deposits.id, id));
    const [row] = await db.select().from(deposits).where(eq(deposits.id, id));
    expect(row?.status).toBe('cancelled');
  });

  it('refuses a move the table does not allow, and any change of a final deposit', async () => {
    const id = await deposit({ customerId: await customer() });
    expect(
      await refusal(db.update(deposits).set({ status: 'credited' }).where(eq(deposits.id, id))),
    ).toMatch(/cannot move from pending to credited/);
    await db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, id));
    expect(
      await refusal(db.update(deposits).set({ status: 'pending' }).where(eq(deposits.id, id))),
    ).toMatch(/is final \(expired\)/);
  });

  it('refuses a change of what was declared', async () => {
    const id = await deposit({ customerId: await customer() });
    for (const change of [
      { declaredAmountUnits: 20 * USD },
      { referenceCode: referenceCode() },
      { customerId: await customer() },
      { idempotencyKey: newId() },
    ]) {
      expect(await refusal(db.update(deposits).set(change).where(eq(deposits.id, id)))).toMatch(
        /cannot change what was declared/,
      );
    }
  });

  it('lets a pending unfixed quote change, never a fixed or submitted one', async () => {
    const id = await deposit({ customerId: await customer(), currency: 'SYP' });
    const requote = async () =>
      db
        .update(deposits)
        .set({ rateId: await rate('120'), rate: '120', declaredUsdUnits: 16_660_000 })
        .where(eq(deposits.id, id));
    await requote();
    await db
      .update(deposits)
      .set({ ...submitted, rateFixedAt: sql`now()` })
      .where(eq(deposits.id, id));
    expect(await refusal(requote())).toMatch(/cannot change its quote/);
    expect(
      await refusal(
        db
          .update(deposits)
          .set({ rateFixedAt: sql`now() + interval '1 second'` })
          .where(eq(deposits.id, id)),
      ),
    ).toMatch(/has a fixed rate/);
    // Back to pending after a receipt request: the rate stays fixed (rule SC9).
    await db
      .update(deposits)
      .set({ status: 'pending', receiptRequestCount: 1, receiptRequestedAt: sql`now()` })
      .where(eq(deposits.id, id));
    expect(await refusal(requote())).toMatch(/cannot change its quote/);
  });

  it('refuses to undo a receipt request', async () => {
    const id = await deposit({ customerId: await customer() });
    await db.update(deposits).set(submitted).where(eq(deposits.id, id));
    await db
      .update(deposits)
      .set({ status: 'pending', receiptRequestCount: 1, receiptRequestedAt: sql`now()` })
      .where(eq(deposits.id, id));
    expect(
      await refusal(
        db
          .update(deposits)
          .set({ receiptRequestCount: 0, receiptRequestedAt: null })
          .where(eq(deposits.id, id)),
      ),
    ).toMatch(/cannot undo a receipt request/);
  });

  it('refuses DELETE: the app role lacks the privilege, the owner meets the trigger', async () => {
    const id = await deposit({ customerId: await customer() });
    expect(await refusal(db.delete(deposits).where(eq(deposits.id, id)))).toMatch(
      /permission denied/,
    );
    expect(await refusal(owner.db.delete(deposits).where(eq(deposits.id, id)))).toMatch(
      /never deleted/,
    );
  });
});

describe('the deposit checks', () => {
  it('keeps one pending deposit per customer (rule SC4)', async () => {
    const customerId = await customer();
    await deposit({ customerId });
    expect(await refusal(deposit({ customerId }))).toMatch(/deposits_one_pending_unique/);
    // Another status does not count.
    await deposit({ customerId, ...submitted });
  });

  it.each([
    ['a fraction of a pound', { currency: 'SYP', declaredAmountUnits: 200_050 }, /declared_check/],
    ['a fraction of a cent', { declaredAmountUnits: 10 * USD + 1 }, /declared_check/],
    ['a USD deposit with a quote', { rate: '118' }, /quote_check/],
    ['a SYP deposit without its quote', { currency: 'SYP', rate: null }, /quote_check/],
    ['a bad reference code', { referenceCode: 'VD-0OIL1' }, /reference_code_check/],
    ['a submitted deposit without its time', { status: 'submitted' }, /submitted_check/],
    [
      'a credit without its decision',
      {
        ...submitted,
        status: 'credited',
        decidedAt: sql`now()`,
        adminId: newId(),
        decisionIdempotencyKey: newId(),
      },
      /credit_check/,
    ],
    [
      'a rejection without its reason',
      {
        ...submitted,
        status: 'rejected',
        decidedAt: sql`now()`,
        decidedBy: 'admin',
        adminId: newId(),
        decisionIdempotencyKey: newId(),
      },
      /rejection_check/,
    ],
    [
      'another reason without a note',
      {
        ...submitted,
        status: 'rejected',
        rejectReason: 'other',
        decidedAt: sql`now()`,
        decidedBy: 'admin',
        adminId: newId(),
        decisionIdempotencyKey: newId(),
      },
      /rejection_check/,
    ],
    ['a decision time on a pending deposit', { decidedAt: sql`now()` }, /decided_check/],
    [
      'two receipt requests',
      { receiptRequestCount: 2, receiptRequestedAt: sql`now()` },
      /receipt_request_check/,
    ],
  ] as const)('refuses %s', async (_, values, constraint) => {
    expect(
      await refusal(deposit({ customerId: await customer(), ...(values as Partial<DepositRow>) })),
    ).toMatch(constraint);
  });

  it('refuses settings that break their limits or hours', async () => {
    const valid = {
      ...DEPOSIT_SETTINGS_DEFAULTS,
      shamCashAccountName: 'Vertex',
      shamCashAccountNumber: '0933000000',
      adminId: newId(),
    };
    for (const [change, constraint] of [
      [{ sypEnabled: true }, /qr_check/],
      [{ minDepositUsdUnits: 60 * USD }, /limits_check/],
      [{ flagNewAccountUsdUnits: 25 * USD + 1 }, /limits_check/],
      [{ reviewHoursEnd: '09:00' }, /hours_check/],
      [{ flagVelocityCount: 0 }, /velocity_check/],
      [{ shamCashAccountName: '' }, /account_check/],
    ] as const) {
      expect(await refusal(db.insert(depositSettings).values({ ...valid, ...change }))).toMatch(
        constraint,
      );
    }
    await db.insert(depositSettings).values(valid);
  });
});

describe('append-only deposit records', () => {
  it('refuses to change settings, files, receipts and flags, as the app role and the owner', async () => {
    const [settings] = await db
      .insert(depositSettings)
      .values({
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex',
        shamCashAccountNumber: '0933000000',
        adminId: newId(),
      })
      .returning({ id: depositSettings.id });
    const depositId = await deposit({ customerId: await customer() });
    const fileId = await file();
    const [receipt] = await db
      .insert(depositReceipts)
      .values({ depositId, fileId, originalSha256: randomBytes(32), perceptualHash: -5n })
      .returning({ id: depositReceipts.id });
    const [flag] = await db
      .insert(depositFlags)
      .values({ depositId, code: 'velocity', receiptId: receipt?.id, details: {} })
      .returning({ id: depositFlags.id });
    const statements = [
      sql`update deposit_settings set syp_enabled = false where id = ${settings?.id}`,
      sql`delete from deposit_settings where id = ${settings?.id}`,
      sql`update stored_files set width = 1 where id = ${fileId}`,
      sql`update deposit_receipts set perceptual_hash = 0 where id = ${receipt?.id}`,
      sql`delete from deposit_flags where id = ${flag?.id}`,
    ];
    for (const statement of statements) {
      expect(await refusal(db.execute(statement))).toMatch(/permission denied/);
      expect(await refusal(owner.db.execute(statement))).toMatch(/is append-only/);
    }
  });

  it('raises a flag once per receipt, and once without one', async () => {
    const depositId = await deposit({ customerId: await customer() });
    const [receipt] = await db
      .insert(depositReceipts)
      .values({
        depositId,
        fileId: await file(),
        originalSha256: randomBytes(32),
        perceptualHash: 1n,
      })
      .returning({ id: depositReceipts.id });
    const flag = (receiptId: string | null) =>
      db.insert(depositFlags).values({ depositId, code: 'velocity', receiptId, details: {} });
    await flag(receipt?.id ?? null);
    await flag(null);
    expect(await refusal(flag(receipt?.id ?? null))).toMatch(/deposit_flags_once_unique/);
    expect(await refusal(flag(null))).toMatch(/deposit_flags_once_unique/);
  });

  it('keeps a receipt hash at 32 bytes', async () => {
    const depositId = await deposit({ customerId: await customer() });
    expect(
      await refusal(
        db.insert(depositReceipts).values({
          depositId,
          fileId: await file(),
          originalSha256: randomBytes(16),
          perceptualHash: 1n,
        }),
      ),
    ).toMatch(/sha256_check/);
  });
});

describe('the deposit credit (money flows M1–M3)', () => {
  const postings = async (journalId: string) =>
    db
      .select({
        code: ledgerAccounts.code,
        currency: ledgerPostings.currency,
        amountUnits: ledgerPostings.amountUnits,
      })
      .from(ledgerPostings)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerPostings.accountId))
      .where(eq(ledgerPostings.journalId, journalId))
      .orderBy(ledgerPostings.position);

  it('credits USD received against the Sham Cash USD account (M1)', async () => {
    const customerId = await customer();
    const depositId = await deposit({ customerId });
    const credit = await db.transaction((tx) =>
      postDepositCredit(tx, {
        depositId,
        customerId,
        receivedCurrency: 'USD',
        receivedAmountUnits: 10 * USD,
        creditedUsdUnits: 10 * USD,
      }),
    );
    expect(credit.balanceAfterUnits).toBe(10 * USD);
    expect(await postings(credit.journalId)).toEqual([
      { code: `customer_wallet:${customerId}`, currency: 'USD', amountUnits: 10 * USD },
      { code: 'sham_cash_receipts:USD', currency: 'USD', amountUnits: -10 * USD },
    ]);
  });

  it('holds the pounds received and balances each currency (M2, M3)', async () => {
    const customerId = await customer();
    const depositId = await deposit({ customerId, currency: 'SYP' });
    // 1,900 SYP at 118 is $16.101…: $16.10 credited, the rest stays as pounds.
    const credit = await db.transaction((tx) =>
      postDepositCredit(tx, {
        depositId,
        customerId,
        receivedCurrency: 'SYP',
        receivedAmountUnits: 190_000,
        creditedUsdUnits: 16_100_000,
      }),
    );
    expect(await postings(credit.journalId)).toEqual([
      { code: 'sham_cash_receipts:SYP', currency: 'SYP', amountUnits: -190_000 },
      { code: 'currency_exchange:SYP', currency: 'SYP', amountUnits: 190_000 },
      { code: 'currency_exchange:USD', currency: 'USD', amountUnits: -16_100_000 },
      { code: `customer_wallet:${customerId}`, currency: 'USD', amountUnits: 16_100_000 },
    ]);
    const wallet = await findCustomerWallet(db, customerId);
    expect(wallet && (await accountBalance(db, wallet))).toBe(16_100_000);
  });

  it('credits a deposit once: the same key returns the first journal', async () => {
    const customerId = await customer();
    const depositId = await deposit({ customerId });
    const credit = {
      depositId,
      customerId,
      receivedCurrency: 'USD',
      receivedAmountUnits: 5 * USD,
      creditedUsdUnits: 5 * USD,
    } as const;
    const first = await db.transaction((tx) => postDepositCredit(tx, credit));
    const again = await db.transaction((tx) => postDepositCredit(tx, credit));
    expect(again.journalId).toBe(first.journalId);
    expect(again.balanceAfterUnits).toBe(5 * USD);
  });

  it('shows the deposit on the wallet timeline with its pounds and rate', async () => {
    const customerId = await customer();
    const depositId = await deposit({ customerId, currency: 'SYP' });
    const credit = await db.transaction(async (tx) => {
      const posted = await postDepositCredit(tx, {
        depositId,
        customerId,
        receivedCurrency: 'SYP',
        receivedAmountUnits: 190_000,
        creditedUsdUnits: 16_100_000,
      });
      const [row] = await tx.select().from(deposits).where(eq(deposits.id, depositId));
      await tx.update(deposits).set(submitted).where(eq(deposits.id, depositId));
      await tx
        .update(deposits)
        .set({
          status: 'credited',
          decidedAt: sql`now()`,
          adminId: newId(),
          decisionIdempotencyKey: newId(),
          transactionNumber: 'T-1',
          receivedCurrency: 'SYP',
          receivedAmountUnits: 190_000,
          creditedUsdUnits: 16_100_000,
          creditRateId: row?.rateId,
          creditRate: '118.5',
          referenceCheck: 'matches',
          journalId: posted.journalId,
        })
        .where(eq(deposits.id, depositId));
      return posted;
    });
    const { entries } = await walletTimeline(db, credit.walletAccountId, { limit: 5 });
    const [row] = await db
      .select({ referenceCode: deposits.referenceCode })
      .from(deposits)
      .where(eq(deposits.id, depositId));
    expect(entries.map((entry) => entry.deposit)).toEqual([
      {
        id: depositId,
        method: 'sham_cash',
        referenceCode: row?.referenceCode,
        syp: { amountUnits: 190_000, rate: '118.5' },
        txid: null,
      },
    ]);
  });
});

describe('payment references of deposits (rule SC14)', () => {
  it('claims for a deposit and names it to a second claim', async () => {
    const depositId = await deposit({ customerId: await customer() });
    const reference = `TX-${newId().slice(-12)}`;
    await db.transaction((tx) => claimPaymentReference(tx, 'sham_cash', reference, { depositId }));
    expect(await paymentReferenceOwner(db, 'sham_cash', ` ${reference.toLowerCase()} `)).toEqual({
      kind: 'deposit',
      id: depositId,
    });
    const other = await deposit({ customerId: await customer() });
    const refused = await db
      .transaction((tx) => claimPaymentReference(tx, 'sham_cash', reference, { depositId: other }))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LedgerError);
    expect((refused as LedgerError).details).toEqual({ kind: 'deposit', id: depositId });
  });

  it('refuses a claim with no owner or two', async () => {
    const depositId = await deposit({ customerId: await customer() });
    const owners = [
      sql`null, null`,
      sql`${depositId}, (select id from wallet_adjustments order by created_at limit 1)`,
    ];
    for (const [index, values] of owners.entries()) {
      expect(
        await refusal(
          db.execute(
            sql`insert into payment_references (id, method, reference, deposit_id, wallet_adjustment_id)
              values (${newId()}, 'sham_cash', ${`OWNERS-${index}-${newId().slice(-8)}`}, ${values})`,
          ),
        ),
      ).toMatch(/owner_check/);
    }
  });
});

/* S04: USDT deposits ------------------------------------------------------------------------ */

const TRON_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const txid = () => randomBytes(32).toString('hex');
/** A free amount per test: random whole dollars, so open-amount checks never collide. */
const freshDollars = () => (100 + (randomBytes(3).readUIntBE(0, 3) % 900_000)) * USD;

/** A pending USDT deposit of `declared` and its USDT row with `tail`. */
async function usdtDeposit(
  options: {
    customerId?: string;
    declared?: number;
    tail?: number;
    method?: 'usdt_trc20' | 'usdt_bep20';
  } = {},
) {
  const declared = options.declared ?? freshDollars();
  const tail = options.tail ?? 3_700;
  const method = options.method ?? 'usdt_trc20';
  const depositId = await deposit({
    customerId: options.customerId ?? (await customer()),
    method,
    declaredAmountUnits: declared,
    declaredUsdUnits: declared,
  });
  await db.insert(usdtDeposits).values({
    depositId,
    method,
    receivingAddress: TRON_ADDRESS,
    tailUnits: tail,
    payAmountUnits: declared + tail,
  });
  return { depositId, payAmountUnits: declared + tail, declared, tail, method };
}

async function transfer(values: Partial<typeof usdtTransfers.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(usdtTransfers).values({
    id,
    method: 'usdt_trc20',
    txid: txid(),
    fromAddress: 'TXfromAddressxxxxxxxxxxxxxxxxxxxxx',
    toAddress: TRON_ADDRESS,
    rawAmount: '25003700',
    amountUnits: 25_003_700,
    blockNumber: 1,
    blockTime: new Date(),
    source: 'scan',
    ...values,
  });
  return id;
}

const usdtRow = async (depositId: string) =>
  (await db.select().from(usdtDeposits).where(eq(usdtDeposits.depositId, depositId)))[0];

describe('deposit decisions (S04)', () => {
  const credited = (journalId: string, values: Partial<DepositRow> = {}) =>
    ({
      status: 'credited',
      decidedAt: sql`now()`,
      decidedBy: 'system',
      transactionNumber: txid(),
      receivedCurrency: 'USD',
      receivedAmountUnits: 10 * USD,
      creditedUsdUnits: 10 * USD,
      journalId,
      ...values,
    }) as const;

  async function journalFor(customerId: string, depositId: string) {
    const posted = await db.transaction((tx) =>
      postUsdtDepositCredit(tx, {
        depositId,
        customerId,
        transferMethod: 'usdt_trc20',
        receivedUnits: 10 * USD,
        creditedUsdUnits: 10 * USD,
      }),
    );
    return posted.journalId;
  }

  it('lets the system credit a USDT deposit without an admin or a reference check', async () => {
    const customerId = await customer();
    const { depositId } = await usdtDeposit({ customerId });
    await db.update(deposits).set(submitted).where(eq(deposits.id, depositId));
    const journalId = await journalFor(customerId, depositId);
    await db.update(deposits).set(credited(journalId)).where(eq(deposits.id, depositId));
    const [row] = await db.select().from(deposits).where(eq(deposits.id, depositId));
    expect(row).toMatchObject({ status: 'credited', decidedBy: 'system', adminId: null });
    expect((await usdtRow(depositId))?.depositOpen).toBe(false);
  });

  it.each([
    ['a system decision with an admin', { adminId: newId() }, /decided_check/],
    [
      'an admin decision without its key',
      { decidedBy: 'admin', adminId: newId() },
      /decided_check/,
    ],
    ['a reference check on USDT', { referenceCheck: 'matches' }, /credit_check/],
  ] as const)('refuses %s', async (_, values, constraint) => {
    const customerId = await customer();
    const { depositId } = await usdtDeposit({ customerId });
    await db.update(deposits).set(submitted).where(eq(deposits.id, depositId));
    const journalId = await journalFor(customerId, depositId);
    expect(
      await refusal(
        db
          .update(deposits)
          .set(credited(journalId, values as Partial<DepositRow>))
          .where(eq(deposits.id, depositId)),
      ),
    ).toMatch(constraint);
  });

  it('refuses a Sham Cash credit without its reference check, and a USDT deposit in pounds', async () => {
    expect(
      await refusal(
        deposit({
          customerId: await customer(),
          ...submitted,
          status: 'credited',
          decidedAt: new Date(),
          decidedBy: 'admin',
          adminId: newId(),
          decisionIdempotencyKey: newId(),
          transactionNumber: 'T-1',
          receivedCurrency: 'USD',
          receivedAmountUnits: 10 * USD,
          creditedUsdUnits: 10 * USD,
          journalId: newId(),
        }),
      ),
    ).toMatch(/credit_check/);
    expect(
      await refusal(
        deposit({ customerId: await customer(), method: 'usdt_bep20', currency: 'SYP' }),
      ),
    ).toMatch(/method_check/);
  });

  it("records a decision of the S03 release, which does not know `decided_by`, as the admin's", async () => {
    const id = await deposit({ customerId: await customer(), ...submitted });
    await db
      .update(deposits)
      .set({
        status: 'rejected',
        rejectReason: 'not_received',
        decidedAt: sql`now()`,
        adminId: newId(),
        decisionIdempotencyKey: newId(),
      })
      .where(eq(deposits.id, id));
    const [row] = await db.select().from(deposits).where(eq(deposits.id, id));
    expect(row?.decidedBy).toBe('admin');
  });
});

describe('the deposit guard for USDT (S04)', () => {
  it('returns a submitted USDT deposit to pending only with its TXID failure (rule U10)', async () => {
    const { depositId } = await usdtDeposit();
    await db.update(deposits).set(submitted).where(eq(deposits.id, depositId));
    expect(
      await refusal(
        db.update(deposits).set({ status: 'pending' }).where(eq(deposits.id, depositId)),
      ),
    ).toMatch(/only with its TXID failure/);
    await db.transaction(async (tx) => {
      await tx
        .update(usdtDeposits)
        .set({ checkError: 'not_found' })
        .where(eq(usdtDeposits.depositId, depositId));
      await tx.update(deposits).set({ status: 'pending' }).where(eq(deposits.id, depositId));
    });
    expect((await usdtRow(depositId))?.depositOpen).toBe(true);
  });

  it('returns a submitted Sham Cash deposit to pending only by a receipt request', async () => {
    const id = await deposit({ customerId: await customer(), ...submitted });
    expect(
      await refusal(db.update(deposits).set({ status: 'pending' }).where(eq(deposits.id, id))),
    ).toMatch(/only by a receipt request/);
  });

  it("never changes a USDT deposit's declared dollars, even while pending", async () => {
    const { depositId } = await usdtDeposit();
    expect(
      await refusal(
        db
          .update(deposits)
          .set({ declaredUsdUnits: 1 * USD })
          .where(eq(deposits.id, depositId)),
      ),
    ).toMatch(/cannot change its quote/);
  });
});

describe('USDT deposit rows (S04)', () => {
  it("takes its deposit's method and the declared amount plus the tail", async () => {
    const declared = freshDollars();
    const depositId = await deposit({
      customerId: await customer(),
      method: 'usdt_trc20',
      declaredAmountUnits: declared,
      declaredUsdUnits: declared,
    });
    const row = {
      depositId,
      method: 'usdt_trc20',
      receivingAddress: TRON_ADDRESS,
      tailUnits: 3_700,
      payAmountUnits: declared + 3_700,
    } as const;
    expect(await refusal(db.insert(usdtDeposits).values({ ...row, method: 'usdt_bep20' }))).toMatch(
      /must match its deposit/,
    );
    expect(
      await refusal(
        db.insert(usdtDeposits).values({ ...row, payAmountUnits: declared + USD + 3_700 }),
      ),
    ).toMatch(/must match its deposit/);
    expect(
      await refusal(
        db.insert(usdtDeposits).values({ ...row, tailUnits: 150, payAmountUnits: declared + 150 }),
      ),
    ).toMatch(/amount_check/);
    expect(await refusal(db.insert(usdtDeposits).values({ ...row, depositOpen: false }))).toMatch(
      /must mirror/,
    );
    await db.insert(usdtDeposits).values(row);
  });

  it('never changes what was shown, nor its transfer once bound', async () => {
    const { depositId } = await usdtDeposit();
    for (const change of [
      { receivingAddress: 'TOther' },
      { tailUnits: 3_800 },
      { payAmountUnits: 1 },
      { depositOpen: false },
    ]) {
      expect(
        await refusal(
          db.update(usdtDeposits).set(change).where(eq(usdtDeposits.depositId, depositId)),
        ),
      ).toMatch(/cannot change what was shown|must mirror/);
    }
    await db.update(deposits).set(submitted).where(eq(deposits.id, depositId));
    const bind = (transferId: string) =>
      db
        .update(usdtDeposits)
        .set({ transferId, checkStatus: 'confirming', txid: txid(), txidSource: 'scan' })
        .where(eq(usdtDeposits.depositId, depositId));
    await bind(await transfer());
    expect(await refusal(bind(await transfer()))).toMatch(/is bound to its transfer/);
  });

  it('keeps open amounts unique per network, and frees one when its deposit closes (rule U3)', async () => {
    const first = await usdtDeposit();
    expect(await refusal(usdtDeposit({ declared: first.declared, tail: first.tail }))).toMatch(
      /usdt_deposits_open_amount_unique/,
    );
    // The other network, or another tail, is free.
    await usdtDeposit({ declared: first.declared, tail: first.tail, method: 'usdt_bep20' });
    await usdtDeposit({ declared: first.declared, tail: first.tail + 100 });
    await db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, first.depositId));
    expect((await usdtRow(first.depositId))?.depositOpen).toBe(false);
    await usdtDeposit({ declared: first.declared, tail: first.tail });
  });

  it('refuses DELETE and TRUNCATE: the app role lacks the privilege, the owner meets the trigger', async () => {
    const { depositId } = await usdtDeposit();
    expect(
      await refusal(db.delete(usdtDeposits).where(eq(usdtDeposits.depositId, depositId))),
    ).toMatch(/permission denied/);
    expect(
      await refusal(owner.db.delete(usdtDeposits).where(eq(usdtDeposits.depositId, depositId))),
    ).toMatch(/never deleted/);
    expect(await refusal(owner.db.execute(sql`truncate usdt_deposits cascade`))).toMatch(
      /append-only/,
    );
  });
});

describe('USDT transfers (S04 rule U13)', () => {
  it('records a transaction once per network', async () => {
    const hash = txid();
    await transfer({ txid: hash });
    expect(await refusal(transfer({ txid: hash }))).toMatch(/usdt_transfers_txid_unique/);
    await transfer({ txid: hash, method: 'usdt_bep20' });
  });

  it.each([
    ['dust under $1 (rule U14)', { amountUnits: 999_999 }, /amount_check/],
    ['a TXID with 0x', { txid: `0x${txid().slice(2)}` }, /txid_check/],
    ['Sham Cash', { method: 'sham_cash' }, /method_check/],
  ] as const)('refuses %s', async (_, values, constraint) => {
    expect(await refusal(transfer(values))).toMatch(constraint);
  });

  it('is append-only for the app role and the owner', async () => {
    const id = await transfer();
    expect(
      await refusal(
        db.update(usdtTransfers).set({ blockNumber: 2 }).where(eq(usdtTransfers.id, id)),
      ),
    ).toMatch(/permission denied/);
    for (const work of [
      owner.db.update(usdtTransfers).set({ blockNumber: 2 }).where(eq(usdtTransfers.id, id)),
      owner.db.delete(usdtTransfers).where(eq(usdtTransfers.id, id)),
    ]) {
      expect(await refusal(work)).toMatch(/usdt_transfers is append-only/);
    }
  });
});

describe('USDT settings (S04)', () => {
  it('reads older versions as disabled with the $5 minimum', async () => {
    const id = newId();
    const { usdtTrc20Enabled, usdtBep20Enabled, usdtMinDepositUsdUnits, ...older } =
      DEPOSIT_SETTINGS_DEFAULTS;
    await db.insert(depositSettings).values({
      ...older,
      id,
      shamCashAccountName: 'Vertex',
      shamCashAccountNumber: '0933000000',
      adminId: newId(),
    });
    const [row] = await db.select().from(depositSettings).where(eq(depositSettings.id, id));
    expect(row).toMatchObject({
      usdtTrc20Enabled: false,
      usdtBep20Enabled: false,
      usdtMinDepositUsdUnits: 5 * USD,
    });
    expect(
      await refusal(
        db.insert(depositSettings).values({
          ...DEPOSIT_SETTINGS_DEFAULTS,
          shamCashAccountName: 'Vertex',
          shamCashAccountNumber: '0933000000',
          adminId: newId(),
          usdtMinDepositUsdUnits: 5 * USD + 1,
        }),
      ),
    ).toMatch(/usdt_min_check/);
  });
});

describe('the USDT credit (S04 money flows M1, M2)', () => {
  const postings = async (journalId: string) =>
    db
      .select({ code: ledgerAccounts.code, amountUnits: ledgerPostings.amountUnits })
      .from(ledgerPostings)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerPostings.accountId))
      .where(eq(ledgerPostings.journalId, journalId))
      .orderBy(ledgerPostings.position);

  it('credits the declared cents and keeps the tail in deposit_rounding', async () => {
    const customerId = await customer();
    const { depositId, declared, payAmountUnits } = await usdtDeposit({ customerId });
    const credit = await db.transaction((tx) =>
      postUsdtDepositCredit(tx, {
        depositId,
        customerId,
        transferMethod: 'usdt_trc20',
        receivedUnits: payAmountUnits,
        creditedUsdUnits: declared,
      }),
    );
    expect(credit.balanceAfterUnits).toBe(declared);
    expect(await postings(credit.journalId)).toEqual([
      { code: 'usdt_receipts:usdt_trc20', amountUnits: -payAmountUnits },
      { code: `customer_wallet:${customerId}`, amountUnits: declared },
      { code: 'deposit_rounding:USD', amountUnits: 3_700 },
    ]);
  });

  it('posts two postings when nothing is left over, from the network the money came on', async () => {
    const customerId = await customer();
    const { depositId } = await usdtDeposit({ customerId });
    const credit = {
      depositId,
      customerId,
      transferMethod: 'usdt_bep20',
      receivedUnits: 24 * USD,
      creditedUsdUnits: 24 * USD,
    } as const;
    const first = await db.transaction((tx) => postUsdtDepositCredit(tx, credit));
    expect(await postings(first.journalId)).toEqual([
      { code: 'usdt_receipts:usdt_bep20', amountUnits: -24 * USD },
      { code: `customer_wallet:${customerId}`, amountUnits: 24 * USD },
    ]);
    const again = await db.transaction((tx) => postUsdtDepositCredit(tx, credit));
    expect(again.journalId).toBe(first.journalId);
  });

  it('never credits more than was received', async () => {
    const customerId = await customer();
    const { depositId } = await usdtDeposit({ customerId });
    await expect(
      db.transaction((tx) =>
        postUsdtDepositCredit(tx, {
          depositId,
          customerId,
          transferMethod: 'usdt_trc20',
          receivedUnits: 9_990_000,
          creditedUsdUnits: 10 * USD,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe('TXID claims (S04)', () => {
  it('finds and refuses a TXID an S02 manual deposit stored with 0x', async () => {
    const hash = txid();
    const depositId = await deposit({ customerId: await customer() });
    // A development row from before S04: the reference as typed, with 0x.
    await owner.db.execute(
      sql`insert into payment_references (id, method, reference, deposit_id)
        values (${newId()}, 'usdt_trc20', ${`0X${hash.toUpperCase()}`}, ${depositId})`,
    );
    expect(await paymentReferenceOwner(db, 'usdt_trc20', hash)).toEqual({
      kind: 'deposit',
      id: depositId,
    });
    expect(await paymentReferenceOwner(db, 'usdt_bep20', hash)).toBeNull();
    const other = await deposit({ customerId: await customer() });
    const refused = await db
      .transaction((tx) => claimPaymentReference(tx, 'usdt_trc20', hash, { depositId: other }))
      .catch((error: unknown) => error);
    expect((refused as LedgerError).details).toEqual({ kind: 'deposit', id: depositId });
  });
});
