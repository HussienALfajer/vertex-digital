import { CURRENCY_SCALE, type Currency, type LedgerAccountKind } from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { customers, ledgerAccounts, ledgerJournals, ledgerPostings } from '../schema/index.js';
import { accountBalance } from './balance.js';
import { LedgerError } from './errors.js';
import { type JournalInput, postJournal } from './post-journal.js';

/*
 * Ledger rows written here stay in the test database: it is append-only by design. Every test
 * uses new accounts and keys, so runs never collide.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;

afterAll(() => connection.close());

const DOLLAR = CURRENCY_SCALE.USD;

async function account(kind: LedgerAccountKind, currency: Currency = 'USD'): Promise<string> {
  const id = newId();
  // A customer wallet names its customer (S02): a new one per wallet.
  const customerId = kind === 'customer_wallet' ? await customer() : null;
  await db.insert(ledgerAccounts).values({ id, code: `test:${id}`, kind, currency, customerId });
  return id;
}

async function customer(): Promise<string> {
  const id = newId();
  await db
    .insert(customers)
    .values({ id, name: 'Test', email: `${id}@test.vertex-digital.local`, phone: '+963900000000' });
  return id;
}

const newKey = () => `test:${newId()}`;

const post = (input: JournalInput) => db.transaction((tx) => postJournal(tx, input));

const balance = (accountId: string) => accountBalance(db, accountId);

/** A new customer wallet holding `units`, deposited from a new Sham Cash receipts account. */
async function fundedWallet(units: number): Promise<string> {
  const wallet = await account('customer_wallet');
  const receipts = await account('sham_cash_receipts');
  await post({
    idempotencyKey: newKey(),
    kind: 'deposit',
    postings: [
      { accountId: wallet, amountUnits: units },
      { accountId: receipts, amountUnits: -units },
    ],
  });
  return wallet;
}

/** A purchase that takes `units` from `wallet` into a new sales revenue account. */
async function purchase(wallet: string, units: number, idempotencyKey = newKey()) {
  const revenue = await account('sales_revenue');
  return {
    idempotencyKey,
    kind: 'purchase',
    postings: [
      { accountId: wallet, amountUnits: -units },
      { accountId: revenue, amountUnits: units },
    ],
  } satisfies JournalInput;
}

async function postingCount(journalId: string): Promise<number> {
  return db.$count(ledgerPostings, eq(ledgerPostings.journalId, journalId));
}

describe('postJournal', () => {
  it('posts a balanced journal; a balance is the sum of its postings', async () => {
    const wallet = await account('customer_wallet');
    const receipts = await account('sham_cash_receipts');
    const revenue = await account('sales_revenue');

    const deposit = await post({
      idempotencyKey: newKey(),
      kind: 'deposit',
      postings: [
        { accountId: wallet, amountUnits: 10 * DOLLAR },
        { accountId: receipts, amountUnits: -10 * DOLLAR },
      ],
    });
    await post({
      idempotencyKey: newKey(),
      kind: 'purchase',
      postings: [
        { accountId: wallet, amountUnits: -3 * DOLLAR },
        { accountId: revenue, amountUnits: 3 * DOLLAR },
      ],
    });

    expect(deposit.created).toBe(true);
    expect(await postingCount(deposit.journalId)).toBe(2);
    expect(await balance(wallet)).toBe(7 * DOLLAR);
    expect(await balance(revenue)).toBe(3 * DOLLAR);
    // System accounts may go below zero: the receipts account mirrors the money received.
    expect(await balance(receipts)).toBe(-10 * DOLLAR);
  });

  it('gives an account without postings a balance of zero', async () => {
    expect(await balance(await account('customer_wallet'))).toBe(0);
  });

  it('lets a wallet spend its whole balance, down to exactly zero', async () => {
    const wallet = await fundedWallet(5 * DOLLAR);
    await post(await purchase(wallet, 5 * DOLLAR));
    expect(await balance(wallet)).toBe(0);
  });

  it('keeps sub-cent precision on system accounts (supplier costs)', async () => {
    const cost = await account('cost_of_goods');
    const prepaid = await account('supplier_prepaid');
    await post({
      idempotencyKey: newKey(),
      kind: 'cost_of_goods',
      postings: [
        { accountId: cost, amountUnits: 889_000 },
        { accountId: prepaid, amountUnits: -889_000 },
      ],
    });
    expect(await balance(prepaid)).toBe(-889_000);
  });

  it('posts journals in several currencies, balanced in each', async () => {
    const usdIn = await account('adjustments');
    const usdOut = await account('sales_revenue');
    const sypIn = await account('sham_cash_receipts', 'SYP');
    const sypOut = await account('adjustments', 'SYP');
    const result = await post({
      idempotencyKey: newKey(),
      kind: 'adjustment',
      postings: [
        { accountId: usdIn, amountUnits: DOLLAR },
        { accountId: usdOut, amountUnits: -DOLLAR },
        { accountId: sypIn, amountUnits: 11_850 },
        { accountId: sypOut, amountUnits: -11_850 },
      ],
    });
    expect(await postingCount(result.journalId)).toBe(4);
    expect(await balance(sypIn)).toBe(11_850);
  });
});

describe('postJournal idempotency', () => {
  it('returns the first journal for a repeated key and posts nothing again', async () => {
    const wallet = await fundedWallet(10 * DOLLAR);
    const input = await purchase(wallet, 4 * DOLLAR);

    const first = await post(input);
    // The same content in another order, with the account id in capitals: still the same journal.
    const again = await post({
      ...input,
      postings: [...input.postings]
        .reverse()
        .map((posting) => ({ ...posting, accountId: posting.accountId.toUpperCase() })),
    });

    expect(first.created).toBe(true);
    expect(again).toEqual({ journalId: first.journalId, created: false });
    expect(await postingCount(first.journalId)).toBe(2);
    expect(await balance(wallet)).toBe(6 * DOLLAR);
  });

  it('replays a debit even after the money it took is gone', async () => {
    const wallet = await fundedWallet(10 * DOLLAR);
    const input = await purchase(wallet, 8 * DOLLAR);
    const first = await post(input);
    // 2 dollars left: a fresh 8-dollar debit would be refused, a retry of the first is not.
    expect(await post(input)).toEqual({ journalId: first.journalId, created: false });
    expect(await balance(wallet)).toBe(2 * DOLLAR);
  });

  it('refuses a repeated key with other postings or another kind', async () => {
    const wallet = await fundedWallet(10 * DOLLAR);
    const input = await purchase(wallet, 2 * DOLLAR);
    await post(input);

    const otherAmount = await purchase(wallet, 3 * DOLLAR, input.idempotencyKey);
    await expect(post(otherAmount)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(post({ ...input, kind: 'adjustment' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await balance(wallet)).toBe(8 * DOLLAR);
  });
});

describe('postJournal wallet balance', () => {
  it('refuses a debit beyond the balance and claims nothing', async () => {
    const wallet = await fundedWallet(5 * DOLLAR);
    const input = await purchase(wallet, 6 * DOLLAR);

    const refusal = post(input);
    await expect(refusal).rejects.toBeInstanceOf(LedgerError);
    await expect(refusal).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    const [journal] = await db
      .select()
      .from(ledgerJournals)
      .where(eq(ledgerJournals.idempotencyKey, input.idempotencyKey));
    expect(journal).toBeUndefined();
    expect(await balance(wallet)).toBe(5 * DOLLAR);

    // The key was not claimed: once the wallet is topped up, the same purchase goes through.
    await post({
      idempotencyKey: newKey(),
      kind: 'deposit',
      postings: [
        { accountId: wallet, amountUnits: DOLLAR },
        { accountId: await account('sham_cash_receipts'), amountUnits: -DOLLAR },
      ],
    });
    expect((await post(input)).created).toBe(true);
    expect(await balance(wallet)).toBe(0);
  });

  it("leaves the caller's transaction usable after a refusal", async () => {
    const wallet = await fundedWallet(5 * DOLLAR);
    const tooMuch = await purchase(wallet, 9 * DOLLAR);
    const enough = await purchase(wallet, 2 * DOLLAR);

    await db.transaction(async (tx) => {
      await expect(postJournal(tx, tooMuch)).rejects.toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });
      await postJournal(tx, enough);
    });

    expect(await balance(wallet)).toBe(3 * DOLLAR);
  });

  it('refuses to debit a wallet outside READ COMMITTED', async () => {
    const wallet = await fundedWallet(5 * DOLLAR);
    const input = await purchase(wallet, DOLLAR);
    await expect(
      db.transaction((tx) => postJournal(tx, input), { isolationLevel: 'repeatable read' }),
    ).rejects.toThrow(/READ COMMITTED/);
    expect(await balance(wallet)).toBe(5 * DOLLAR);
  });
});

describe('postJournal refuses malformed journals', () => {
  it.each<[string, (accounts: { wallet: string; other: string }) => JournalInput]>([
    [
      'an empty idempotency key',
      ({ wallet, other }) => ({
        idempotencyKey: '',
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: DOLLAR },
          { accountId: other, amountUnits: -DOLLAR },
        ],
      }),
    ],
    [
      'an idempotency key over 200 characters',
      ({ wallet, other }) => ({
        idempotencyKey: 'k'.repeat(201),
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: DOLLAR },
          { accountId: other, amountUnits: -DOLLAR },
        ],
      }),
    ],
    [
      'a single posting',
      ({ wallet }) => ({
        idempotencyKey: newKey(),
        kind: 'adjustment',
        postings: [{ accountId: wallet, amountUnits: DOLLAR }],
      }),
    ],
    [
      'a zero amount',
      ({ wallet, other }) => ({
        idempotencyKey: newKey(),
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: 0 },
          { accountId: other, amountUnits: 0 },
        ],
      }),
    ],
    [
      'a fractional amount',
      ({ wallet, other }) => ({
        idempotencyKey: newKey(),
        kind: 'adjustment',
        postings: [
          { accountId: other, amountUnits: 0.5 },
          { accountId: wallet, amountUnits: -0.5 },
        ],
      }),
    ],
    [
      'postings that do not balance',
      ({ wallet, other }) => ({
        idempotencyKey: newKey(),
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: DOLLAR },
          { accountId: other, amountUnits: -DOLLAR + 1 },
        ],
      }),
    ],
    [
      'an unknown account',
      ({ wallet }) => ({
        idempotencyKey: newKey(),
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: DOLLAR },
          { accountId: newId(), amountUnits: -DOLLAR },
        ],
      }),
    ],
    [
      'a customer wallet posting that is not whole cents',
      ({ wallet, other }) => ({
        idempotencyKey: newKey(),
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: DOLLAR + 1 },
          { accountId: other, amountUnits: -DOLLAR - 1 },
        ],
      }),
    ],
  ])('as a programming error: %s', async (_, build) => {
    const wallet = await fundedWallet(10 * DOLLAR);
    const other = await account('adjustments');
    const input = build({ wallet, other });

    const refusal = post(input);
    await expect(refusal).rejects.toThrow(Error);
    await expect(refusal).rejects.not.toBeInstanceOf(LedgerError);
    expect(await balance(wallet)).toBe(10 * DOLLAR);
    expect(await balance(other)).toBe(0);
  });
});

describe('postJournal under concurrency', () => {
  it('never overdraws a wallet with parallel debits', async () => {
    const wallet = await fundedWallet(10 * DOLLAR);
    const debits = await Promise.all(Array.from({ length: 8 }, () => purchase(wallet, 3 * DOLLAR)));

    const results = await Promise.allSettled(debits.map(post));

    const posted = results.filter((result) => result.status === 'fulfilled');
    const refused = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    expect(posted).toHaveLength(3);
    expect(refused).toHaveLength(5);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(LedgerError);
      expect(reason).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    }
    expect(await balance(wallet)).toBe(DOLLAR);
  });

  it('posts a key sent in parallel exactly once', async () => {
    const wallet = await account('customer_wallet');
    const receipts = await account('sham_cash_receipts');
    const input: JournalInput = {
      idempotencyKey: newKey(),
      kind: 'deposit',
      postings: [
        { accountId: wallet, amountUnits: 25 * DOLLAR },
        { accountId: receipts, amountUnits: -25 * DOLLAR },
      ],
    };

    const results = await Promise.all(Array.from({ length: 6 }, () => post(input)));

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.journalId)).size).toBe(1);
    expect(await balance(wallet)).toBe(25 * DOLLAR);
  });

  it('does not deadlock when journals take from the same wallets in opposite orders', async () => {
    const first = await fundedWallet(10 * DOLLAR);
    const second = await fundedWallet(10 * DOLLAR);
    const journals = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const revenue = await account('sales_revenue');
        const [a, b] = i % 2 === 0 ? [first, second] : [second, first];
        return {
          idempotencyKey: newKey(),
          kind: 'purchase',
          postings: [
            { accountId: a, amountUnits: -DOLLAR },
            { accountId: b, amountUnits: -DOLLAR },
            { accountId: revenue, amountUnits: 2 * DOLLAR },
          ],
        } satisfies JournalInput;
      }),
    );

    await Promise.all(journals.map(post));

    expect(await balance(first)).toBe(4 * DOLLAR);
    expect(await balance(second)).toBe(4 * DOLLAR);
  });
});
