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
} from '../schema/index.js';
import { accountBalance } from './balance.js';
import { postDepositCredit } from './deposits.js';
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
