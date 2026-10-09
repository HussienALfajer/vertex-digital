import {
  type Currency,
  isWholeCents,
  type JournalKind,
  type LedgerAccountKind,
} from '@vertex-digital/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { ledgerAccounts, ledgerJournals, ledgerPostings } from '../schema/index.js';
import { accountBalance } from './balance.js';
import { LedgerError } from './errors.js';

export interface PostingInput {
  accountId: string;
  /** Integer units of the account's currency, added to its balance: negative takes from it. */
  amountUnits: number;
}

export interface JournalInput {
  /** The money event's unique key (ADR 0003): the deposit id, `order:<id>:<step>`, the admin action id. */
  idempotencyKey: string;
  kind: JournalKind;
  postings: readonly PostingInput[];
}

export interface PostedJournal {
  journalId: string;
  /** False when the key was already posted with the same content: nothing new was written. */
  created: boolean;
}

/** Longest idempotency key; the database checks the same limit. */
const MAX_KEY_LENGTH = 200;

interface Line extends PostingInput {
  currency: Currency;
  kind: LedgerAccountKind;
}

/**
 * Posts one journal: the only way to write the ledger (ADR 0003). It runs inside the caller's
 * transaction, so the journal commits or rolls back with the order, deposit or audit entry it
 * belongs to, and it is atomic on its own (a savepoint): a refusal leaves nothing behind and the
 * caller's transaction can go on. The transaction must be READ COMMITTED (PostgreSQL's default).
 *
 * - Two or more postings of non-zero integer units, summing to zero per currency; customer wallet
 *   postings in whole cents. A malformed journal is a programming error (`Error`).
 * - The idempotency key is claimed first. A key already posted with the same kind and postings
 *   returns that journal with `created: false`; with other content it is refused
 *   (`IDEMPOTENCY_KEY_REUSED`).
 * - Every customer wallet the journal takes from is locked (`FOR UPDATE`, in id order, so parallel
 *   debits queue instead of deadlocking) and its balance checked: a wallet never goes below zero
 *   (`INSUFFICIENT_BALANCE`).
 */
export async function postJournal(tx: Transaction, input: JournalInput): Promise<PostedJournal> {
  checkShape(input);
  return tx.transaction(async (step) => {
    const lines = await resolveAccounts(step, input.postings);
    checkBalanced(lines);

    const [claimed] = await step
      .insert(ledgerJournals)
      .values({
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        postingCount: lines.length,
      })
      .onConflictDoNothing({ target: ledgerJournals.idempotencyKey })
      .returning({ id: ledgerJournals.id });
    if (!claimed) return replay(step, input);

    await checkWallets(step, lines);
    await step.insert(ledgerPostings).values(
      lines.map((line) => ({
        journalId: claimed.id,
        accountId: line.accountId,
        currency: line.currency,
        amountUnits: line.amountUnits,
      })),
    );
    return { journalId: claimed.id, created: true };
  });
}

function checkShape({ idempotencyKey, postings }: JournalInput): void {
  if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_KEY_LENGTH) {
    throw new Error(`An idempotency key has 1 to ${MAX_KEY_LENGTH} characters`);
  }
  if (postings.length < 2) throw new Error('A journal needs at least two postings');
  for (const { amountUnits } of postings) {
    if (!Number.isSafeInteger(amountUnits) || amountUnits === 0) {
      throw new Error(`A posting amount is a non-zero safe integer, got ${amountUnits}`);
    }
  }
}

async function resolveAccounts(tx: Transaction, postings: readonly PostingInput[]) {
  const ids = [...new Set(postings.map((posting) => posting.accountId))];
  const rows = await tx
    .select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind, currency: ledgerAccounts.currency })
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.id, ids));
  const accounts = new Map(rows.map((row) => [row.id, row]));
  return postings.map((posting): Line => {
    const account = accounts.get(posting.accountId.toLowerCase());
    if (!account) throw new Error(`Unknown ledger account ${posting.accountId}`);
    if (account.kind === 'customer_wallet' && !isWholeCents(posting.amountUnits)) {
      throw new Error(`A customer wallet posting is whole cents, got ${posting.amountUnits}`);
    }
    return { ...posting, accountId: account.id, currency: account.currency, kind: account.kind };
  });
}

function checkBalanced(lines: readonly Line[]): void {
  const totals = new Map<Currency, bigint>();
  for (const line of lines) {
    totals.set(line.currency, (totals.get(line.currency) ?? 0n) + BigInt(line.amountUnits));
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) throw new Error(`The journal is off by ${total} ${currency} units`);
  }
}

async function checkWallets(tx: Transaction, lines: readonly Line[]): Promise<void> {
  const changes = new Map<string, bigint>();
  for (const line of lines) {
    if (line.kind !== 'customer_wallet') continue;
    changes.set(line.accountId, (changes.get(line.accountId) ?? 0n) + BigInt(line.amountUnits));
  }
  const debits = [...changes].filter(([, change]) => change < 0n);
  if (debits.length === 0) return;

  // Under REPEATABLE READ the balance below would come from a snapshot taken before the lock,
  // missing the debits that queued ahead of this one.
  const isolation = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation.rows[0]?.level !== 'read committed') {
    throw new Error('postJournal needs a READ COMMITTED transaction to debit a wallet');
  }

  await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      inArray(
        ledgerAccounts.id,
        debits.map(([accountId]) => accountId),
      ),
    )
    .orderBy(ledgerAccounts.id)
    .for('update');
  for (const [accountId, change] of debits) {
    const balance = await accountBalance(tx, accountId);
    if (BigInt(balance) + change < 0n) {
      throw new LedgerError(
        'INSUFFICIENT_BALANCE',
        `Wallet ${accountId} holds ${balance} units; the journal takes ${-change}`,
        { balanceUnits: Number(balance) },
      );
    }
  }
}

async function replay(tx: Transaction, input: JournalInput): Promise<PostedJournal> {
  const [journal] = await tx
    .select({ id: ledgerJournals.id, kind: ledgerJournals.kind })
    .from(ledgerJournals)
    .where(eq(ledgerJournals.idempotencyKey, input.idempotencyKey));
  if (!journal) {
    throw new Error(`Journal ${input.idempotencyKey} exists but this transaction cannot see it`);
  }
  const posted = await tx
    .select({ accountId: ledgerPostings.accountId, amountUnits: ledgerPostings.amountUnits })
    .from(ledgerPostings)
    .where(eq(ledgerPostings.journalId, journal.id));
  if (journal.kind !== input.kind || fingerprint(posted) !== fingerprint(input.postings)) {
    throw new LedgerError(
      'IDEMPOTENCY_KEY_REUSED',
      `Journal ${input.idempotencyKey} was already posted with other content`,
    );
  }
  return { journalId: journal.id, created: false };
}

/** The postings as an order-free string, to compare a repeated journal with the first. */
function fingerprint(postings: readonly PostingInput[]): string {
  return postings
    .map((posting) => `${posting.accountId.toLowerCase()} ${posting.amountUnits}`)
    .sort()
    .join('\n');
}
