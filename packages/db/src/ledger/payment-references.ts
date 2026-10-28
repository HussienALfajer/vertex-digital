import {
  isUsdtMethod,
  normalizePaymentReference,
  type PaymentMethod,
  TREASURY_ACCOUNTS,
  USDT_METHODS,
} from '@vertex-digital/contracts';
import { and, eq, inArray, or, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { deposits, paymentReferences, walletAdjustments } from '../schema/index.js';
import { LedgerError } from './errors.js';

/*
 * Real-world payment references (Sham Cash transaction numbers, TXIDs), claimed once across every
 * record that can credit them (S03 rule SC14).
 */

/** The record that claimed a reference: shown to the admin in the refusal's `details`. */
export interface PaymentReferenceOwner {
  kind: 'adjustment' | 'deposit';
  id: string;
}

/**
 * How references compare: `normalizePaymentReference` first (direction marks, spaces, Arabic-Indic
 * digits, F4-3), whatever path the reference came by, then trimmed and upper-cased by PostgreSQL
 * as the table's check, the S02 backfill and S02's unique index do.
 */
const normalized = (reference: string) =>
  sql<string>`upper(btrim(${normalizePaymentReference(reference)}))`;

/**
 * The forms a reference may be stored in. A TXID (S04) is claimed as its 64 hex characters, as
 * `txidSchema` normalizes it; S02 manual deposits entered in development before S04 may hold it
 * with `0x`, so both forms are looked up. No such row exists in production (Phase 1 was not
 * deployed before S04).
 */
const storedForms = (method: PaymentMethod, reference: string) => {
  if (!isUsdtMethod(method)) return [normalized(reference)];
  const bare = sql<string>`regexp_replace(${normalized(reference)}, '^0X', '')`;
  return [bare, sql<string>`'0X' || ${bare}`];
};

/**
 * The methods a claim is unique across: a TXID is one transfer whichever USDT network it is
 * claimed under (audit A1; `payment_references_usdt_txid_idx` is the database's backstop), so a
 * manual deposit recorded under the wrong network, or a `wrong_network` approval, cannot claim it
 * a second time. Other methods are their own space.
 */
const claimMethods = (method: PaymentMethod): readonly PaymentMethod[] =>
  isUsdtMethod(method) ? USDT_METHODS : [method];

/**
 * Serializes the writes that take a reference (S03 SC14, S13 T4): a claim here and an
 * `unclaimed_receipt` treasury movement, which hold it in different tables (audit A09-3). A TXID
 * locks the same key under both networks and both stored forms.
 */
export async function lockPaymentReference(
  tx: Transaction,
  method: PaymentMethod,
  reference: string,
): Promise<void> {
  const space = isUsdtMethod(method) ? 'usdt' : method;
  const [bare] = storedForms(method, reference);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`payment-reference:${space}:`} || ${bare}))`,
  );
}

/**
 * The `unclaimed_receipt` treasury movement that booked `reference` into one of the method's
 * places and stands (not reversed), or null (audit A09-3): money booked that way is the store's,
 * so no deposit or manual deposit may credit it again.
 */
export async function unclaimedReceiptHolder(
  db: Database | Transaction,
  method: PaymentMethod,
  reference: string,
): Promise<string | null> {
  const codes = isUsdtMethod(method)
    ? USDT_METHODS.map((network) => TREASURY_ACCOUNTS[network].code)
    : [TREASURY_ACCOUNTS.sham_cash_syp.code, TREASURY_ACCOUNTS.sham_cash_usd.code];
  const [bare] = storedForms(method, reference);
  const booked = isUsdtMethod(method)
    ? sql`regexp_replace(upper(btrim(m.external_reference)), '^0X', '')`
    : sql`upper(btrim(m.external_reference))`;
  const { rows } = await db.execute<{ id: string }>(sql`
    select m.id from treasury_movements m join ledger_accounts a on a.id = m.to_account_id
    where a.code in (${sql.join(
      codes.map((code) => sql`${code}`),
      sql`, `,
    )})
      and m.outside_category = 'unclaimed_receipt' and m.reverses_movement_id is null
      and not exists (select 1 from treasury_movements r where r.reverses_movement_id = m.id)
      and ${booked} = ${bare}
    limit 1`);
  return rows[0]?.id ?? null;
}

/** The record that holds the claim on `reference`, or null when it is free. */
export async function paymentReferenceOwner(
  db: Database | Transaction,
  method: PaymentMethod,
  reference: string,
): Promise<PaymentReferenceOwner | null> {
  const [row] = await db
    .select({
      walletAdjustmentId: paymentReferences.walletAdjustmentId,
      depositId: paymentReferences.depositId,
    })
    .from(paymentReferences)
    .where(
      and(
        inArray(paymentReferences.method, claimMethods(method)),
        or(...storedForms(method, reference).map((form) => eq(paymentReferences.reference, form))),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.depositId) return { kind: 'deposit', id: row.depositId };
  if (!row.walletAdjustmentId) throw new Error('A payment reference has no owner');
  return { kind: 'adjustment', id: row.walletAdjustmentId };
}

/**
 * Claims `reference` for its owner inside the owner's transaction, or refuses with
 * `EXTERNAL_REFERENCE_TAKEN` and the record that holds it. A parallel claim of the same
 * reference (a TXID under either USDT network) waits for the first transaction: if it commits,
 * this one is refused; if it rolls back, this one claims. A refusal leaves the caller's
 * transaction usable.
 */
export async function claimPaymentReference(
  tx: Transaction,
  method: PaymentMethod,
  reference: string,
  owner: { walletAdjustmentId: string } | { depositId: string },
): Promise<void> {
  await lockPaymentReference(tx, method, reference);
  const booked = await unclaimedReceiptHolder(tx, method, reference);
  if (booked) {
    throw new LedgerError(
      'EXTERNAL_REFERENCE_TAKEN',
      'The reference is booked as an unclaimed receipt',
      { kind: 'treasury_movement', id: booked },
    );
  }
  if (isUsdtMethod(method)) {
    const legacy = await paymentReferenceOwner(tx, method, reference);
    if (legacy) {
      throw new LedgerError('EXTERNAL_REFERENCE_TAKEN', 'The TXID is already claimed', legacy);
    }
  }
  const claimed = await tx
    .insert(paymentReferences)
    .values({
      method,
      reference: normalized(reference),
      ...owner,
    })
    // Any unique conflict: the method's reference, or the TXID under the other network.
    .onConflictDoNothing()
    .returning({ id: paymentReferences.id });
  if (claimed.length > 0) return;
  const holder = await paymentReferenceOwner(tx, method, reference);
  // The only other unique columns are the owner's: one record never claims twice.
  if (!holder) throw new Error('The claim conflicted with no holder of its reference');
  throw new LedgerError(
    'EXTERNAL_REFERENCE_TAKEN',
    'The payment reference is already claimed',
    holder,
  );
}

/**
 * True when the TXID `txid` (64 lower-case hex characters) is claimed under either USDT network,
 * in either stored form (audit A1): a filter for the USDT transfer lists (S04 rule U13), without
 * their module reading the claims table itself. Pass a fully qualified expression.
 */
export const txidClaimed = (txid: SQLWrapper) =>
  sql<boolean>`exists (select 1 from payment_references as claim
    where claim.method in ('usdt_trc20', 'usdt_bep20')
      and claim.reference in (upper(${txid}), '0X' || upper(${txid})))`;

/** The record that claimed a TXID, and its customer. */
export interface TxidHolder extends PaymentReferenceOwner {
  customerId: string;
}

/**
 * The holders of claimed TXIDs (64 lower-case hex characters), by TXID, whichever USDT network
 * the claim names (audit A1): the deposit or adjustment that claimed each, and its customer (S04
 * rule U13).
 */
export async function txidHolders(
  db: Database | Transaction,
  txids: readonly string[],
): Promise<Map<string, TxidHolder>> {
  if (txids.length === 0) return new Map();
  const forms = txids.flatMap((txid) => [txid.toUpperCase(), `0X${txid.toUpperCase()}`]);
  const rows = await db
    .select({
      reference: paymentReferences.reference,
      depositId: paymentReferences.depositId,
      adjustmentId: paymentReferences.walletAdjustmentId,
      depositCustomerId: deposits.customerId,
      adjustmentCustomerId: walletAdjustments.customerId,
    })
    .from(paymentReferences)
    .leftJoin(deposits, eq(deposits.id, paymentReferences.depositId))
    .leftJoin(walletAdjustments, eq(walletAdjustments.id, paymentReferences.walletAdjustmentId))
    .where(
      and(
        inArray(paymentReferences.method, USDT_METHODS),
        inArray(paymentReferences.reference, forms),
      ),
    );
  const holders = new Map<string, TxidHolder>();
  for (const row of rows) {
    const txid = row.reference.replace(/^0X/, '').toLowerCase();
    if (row.depositId && row.depositCustomerId) {
      holders.set(txid, { kind: 'deposit', id: row.depositId, customerId: row.depositCustomerId });
    } else if (row.adjustmentId && row.adjustmentCustomerId) {
      holders.set(txid, {
        kind: 'adjustment',
        id: row.adjustmentId,
        customerId: row.adjustmentCustomerId,
      });
    }
  }
  return holders;
}
