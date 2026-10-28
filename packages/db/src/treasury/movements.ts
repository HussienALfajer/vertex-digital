import {
  type ErrorCode,
  impliedRate,
  normalizeTxid,
  type OutsideCategory,
  type PaymentMethod,
  TREASURY_ACCOUNTS,
  type TreasuryEndpoint,
  type TreasuryMovementKind,
  treasuryEndpointOf,
  treasuryPostings,
} from '@vertex-digital/contracts';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import type { AdminActor } from '../customers/index.js';
import { newId } from '../id.js';
import {
  ensureSystemAccount,
  lockPaymentReference,
  paymentReferenceOwner,
  postJournal,
} from '../ledger/index.js';
import { treasuryMovements } from '../schema/index.js';

/*
 * The treasury write path (S13 rules T2–T10, M1–M5, ADR 0027), the only way to write a movement:
 * the key's advisory lock and replay, the two places' locks in id order, the opening and reference
 * rules, the `treasury` journal, the row and its audit entry, all in the caller's transaction. The
 * API checks the pure rules of the contracts (places, amounts, the typed confirmation) first.
 */

/** A movement refusal the API answers with its contract code. */
export class TreasuryError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TreasuryError';
    this.code = code;
    this.details = details;
  }
}

export type TreasuryMovementRow = typeof treasuryMovements.$inferSelect;

export interface MovementInput {
  /** The request's `Idempotency-Key`. */
  idempotencyKey: string;
  kind: TreasuryMovementKind;
  from: TreasuryEndpoint;
  to: TreasuryEndpoint;
  sentUnits: number;
  receivedUnits: number;
  outsideCategory: OutsideCategory | null;
  openingBalance: boolean;
  orderId: string | null;
  externalReference: string | null;
  reason: string;
}

export interface MovementResult {
  movement: TreasuryMovementRow;
  /** False when the key's first request had already written it (a replay). */
  created: boolean;
}

/** The same key waits here for its first request, then reads what it committed. */
async function existingForKey(
  tx: Transaction,
  idempotencyKey: string,
): Promise<TreasuryMovementRow | undefined> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`treasury:${idempotencyKey}`}))`);
  const [row] = await tx
    .select()
    .from(treasuryMovements)
    .where(eq(treasuryMovements.idempotencyKey, idempotencyKey));
  return row;
}

/** The places' locks, in id order, so two movements between the same places never deadlock. */
async function lockAccounts(tx: Transaction, accountIds: string[]): Promise<void> {
  for (const id of [...new Set(accountIds)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`treasury-account:${id}`}))`);
  }
}

function ensureEndpoint(tx: Transaction, endpoint: TreasuryEndpoint): Promise<string> {
  return ensureSystemAccount(tx, TREASURY_ACCOUNTS[endpoint]);
}

/**
 * Rule T6 with edge case 12: true when an opening into the account stands. A reversed opening
 * allows a new one, whatever moved through the place since (audit A09-1: a wrong opening reversed
 * after the place was used left it without an opening for good, its external check skipped).
 */
async function placeHasOpening(tx: Transaction, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: treasuryMovements.id })
    .from(treasuryMovements)
    .where(
      and(
        eq(treasuryMovements.toAccountId, accountId),
        eq(treasuryMovements.openingBalance, true),
        sql`not exists (select 1 from treasury_movements r where r.reverses_movement_id = ${treasuryMovements.id})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * An unclaimed USDT receipt, and a USDT return to its sender (which names the incoming transfer it
 * sends back, Q30), keep the TXID as the claims and the scanner do (64 lower-case hex, from a hash
 * or an explorer link), so the claims and the nightly USDT check find it (audit A09-3, A09-4).
 */
function storedReference(input: MovementInput): string | null {
  const reference = input.externalReference;
  if (reference === null) return reference;
  const place =
    input.outsideCategory === 'unclaimed_receipt'
      ? input.to
      : input.outsideCategory === 'return_to_sender'
        ? input.from
        : null;
  if (place !== 'usdt_trc20' && place !== 'usdt_bep20') return reference;
  return normalizeTxid(reference) ?? reference;
}

function isUsdtReturn(
  input: MovementInput,
): input is MovementInput & { from: 'usdt_trc20' | 'usdt_bep20' } {
  return (
    input.outsideCategory === 'return_to_sender' &&
    (input.from === 'usdt_trc20' || input.from === 'usdt_bep20')
  );
}

/**
 * True when an unreversed movement of the category names the reference: an `unclaimed_receipt`
 * into the account, or a `return_to_sender` out of it (Q30).
 */
async function standingMovement(
  tx: Transaction,
  category: 'unclaimed_receipt' | 'return_to_sender',
  accountId: string,
  reference: string,
): Promise<boolean> {
  const side =
    category === 'unclaimed_receipt'
      ? sql`m.to_account_id = ${accountId}`
      : sql`m.from_account_id = ${accountId}`;
  const { rows } = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from treasury_movements m
      where ${side}
        and m.outside_category = ${category} and m.reverses_movement_id is null
        and not exists (select 1 from treasury_movements r where r.reverses_movement_id = m.id)
        and upper(m.external_reference) = upper(${reference})
    ) as found`);
  return rows[0]?.found === true;
}

/** The deposit method whose money reaches a receipts place, or null for any other place. */
function receiptMethod(endpoint: TreasuryEndpoint): PaymentMethod | null {
  if (endpoint === 'usdt_trc20' || endpoint === 'usdt_bep20') return endpoint;
  if (endpoint === 'sham_cash_syp' || endpoint === 'sham_cash_usd') return 'sham_cash';
  return null;
}

async function postMovementJournal(
  tx: Transaction,
  id: string,
  movement: Pick<MovementInput, 'from' | 'to' | 'sentUnits' | 'receivedUnits'>,
  reversal: boolean,
): Promise<string> {
  const postings = [];
  for (const posting of treasuryPostings({ ...movement, reversal })) {
    postings.push({
      accountId: await ensureSystemAccount(tx, posting),
      amountUnits: posting.amountUnits,
    });
  }
  const { journalId } = await postJournal(tx, {
    idempotencyKey: `treasury:${id}`,
    kind: 'treasury',
    postings,
  });
  return journalId;
}

function auditMovement(row: TreasuryMovementRow, input: Pick<MovementInput, 'from' | 'to'>) {
  return {
    movementId: row.id,
    kind: row.kind,
    from: input.from,
    to: input.to,
    sentUnits: row.sentUnits,
    sentCurrency: row.sentCurrency,
    receivedUnits: row.receivedUnits,
    receivedCurrency: row.receivedCurrency,
    rate: row.rate,
    outsideCategory: row.outsideCategory,
    openingBalance: row.openingBalance,
    orderId: row.orderId,
    externalReference: row.externalReference,
    journalId: row.journalId,
  };
}

function auditEntry(actor: AdminActor, movementId: string, reason: string) {
  return {
    actorKind: 'admin',
    actorId: actor.adminId,
    channel: 'admin',
    entityType: 'treasury_movement',
    entityId: movementId,
    reason,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  } as const;
}

/**
 * Records a transfer or a supplier correction (rules T2–T8, M1–M3, M5). The key replays its first
 * movement; the same key for another request is `IDEMPOTENCY_KEY_REUSED`.
 */
export async function recordMovement(
  tx: Transaction,
  request: MovementInput,
  actor: AdminActor,
): Promise<MovementResult> {
  const input = { ...request, externalReference: storedReference(request) };
  const fromAccountId = await ensureEndpoint(tx, input.from);
  const toAccountId = await ensureEndpoint(tx, input.to);
  const existing = await existingForKey(tx, input.idempotencyKey);
  if (existing) {
    const same =
      existing.reversesMovementId === null &&
      existing.kind === input.kind &&
      existing.fromAccountId === fromAccountId &&
      existing.toAccountId === toAccountId &&
      existing.sentUnits === input.sentUnits &&
      existing.receivedUnits === input.receivedUnits &&
      existing.outsideCategory === input.outsideCategory &&
      existing.openingBalance === input.openingBalance &&
      existing.orderId === input.orderId &&
      existing.externalReference === input.externalReference &&
      existing.reason === input.reason;
    if (!same) {
      throw new TreasuryError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another movement');
    }
    return { movement: existing, created: false };
  }
  await lockAccounts(tx, [fromAccountId, toAccountId]);
  if (input.openingBalance && (await placeHasOpening(tx, toAccountId))) {
    throw new TreasuryError('OPENING_BALANCE_EXISTS', 'The place already has an opening');
  }
  // Q30: a USDT return always names the incoming transfer it sends back (contracts check it too).
  if (isUsdtReturn(input) && input.externalReference === null) {
    throw new TreasuryError('RETURN_RECEIPT_MISSING', 'A USDT return names its incoming TXID');
  }
  if (input.externalReference !== null) {
    const [holder] = await tx
      .select({ id: treasuryMovements.id })
      .from(treasuryMovements)
      .where(
        and(
          eq(treasuryMovements.fromAccountId, fromAccountId),
          isNotNull(treasuryMovements.externalReference),
          isNull(treasuryMovements.reversesMovementId),
          sql`upper(${treasuryMovements.externalReference}) = upper(${input.externalReference})`,
        ),
      );
    if (holder) {
      throw new TreasuryError(
        'EXTERNAL_REFERENCE_TAKEN',
        'The reference is already booked from this place',
        { movementId: holder.id },
      );
    }
    // A USDT return names the incoming transfer it sends back (Q30): only one booked in by a
    // standing unclaimed receipt into the place, so the books took it in once and no deposit can
    // claim it later (the receipt holds its TXID against claims).
    if (isUsdtReturn(input)) {
      await lockPaymentReference(tx, input.from, input.externalReference);
      const reference = input.externalReference;
      if (!(await standingMovement(tx, 'unclaimed_receipt', fromAccountId, reference))) {
        throw new TreasuryError(
          'RETURN_RECEIPT_MISSING',
          'No standing unclaimed receipt into the place names the returned TXID',
        );
      }
    }
    // An unclaimed receipt books money no deposit credited: a reference a deposit or a manual
    // deposit already claimed would count it twice (audit A09-3). The claims check this side.
    const method = receiptMethod(input.to);
    if (input.outsideCategory === 'unclaimed_receipt' && method !== null) {
      await lockPaymentReference(tx, method, input.externalReference);
      const claim = await paymentReferenceOwner(tx, method, input.externalReference);
      if (claim) {
        throw new TreasuryError(
          'EXTERNAL_REFERENCE_TAKEN',
          'The reference is already claimed by a deposit',
          claim,
        );
      }
    }
  }
  const from = TREASURY_ACCOUNTS[input.from];
  const to = TREASURY_ACCOUNTS[input.to];
  let rate: string | null = null;
  if (from.currency !== to.currency) {
    rate =
      from.currency === 'SYP'
        ? impliedRate(input.sentUnits, input.receivedUnits)
        : impliedRate(input.receivedUnits, input.sentUnits);
  }
  const id = newId();
  const journalId = await postMovementJournal(tx, id, input, false);
  const [movement] = await tx
    .insert(treasuryMovements)
    .values({
      id,
      kind: input.kind,
      fromAccountId,
      sentUnits: input.sentUnits,
      sentCurrency: from.currency,
      toAccountId,
      receivedUnits: input.receivedUnits,
      receivedCurrency: to.currency,
      rate,
      outsideCategory: input.outsideCategory,
      openingBalance: input.openingBalance,
      orderId: input.orderId,
      externalReference: input.externalReference,
      reason: input.reason,
      journalId,
      idempotencyKey: input.idempotencyKey,
      adminId: actor.adminId,
    })
    .returning();
  if (!movement) throw new Error('The movement was not written');
  await recordAudit(tx, {
    ...auditEntry(actor, id, input.reason),
    action: 'treasury_movement.created',
    details: auditMovement(movement, input),
  });
  return { movement, created: true };
}

/** The endpoints of a stored movement, from its accounts' codes. */
async function endpointsOf(
  tx: Transaction,
  row: TreasuryMovementRow,
): Promise<{ from: TreasuryEndpoint; to: TreasuryEndpoint }> {
  const codes = await tx.execute<{ id: string; code: string }>(
    sql`select id, code from ledger_accounts where id in (${row.fromAccountId}, ${row.toAccountId})`,
  );
  const endpoint = (accountId: string): TreasuryEndpoint => {
    const code = codes.rows.find((account) => account.id === accountId)?.code;
    const found = code === undefined ? null : treasuryEndpointOf(code);
    if (!found) throw new Error(`Account ${accountId} is no treasury endpoint`);
    return found;
  };
  return { from: endpoint(row.fromAccountId), to: endpoint(row.toAccountId) };
}

/**
 * Reverses a movement once (rules T9, M4): a new row with the same accounts and amounts, mirrored
 * postings and its own reason. A reversal is never reversed.
 */
export async function reverseMovement(
  tx: Transaction,
  input: { movementId: string; idempotencyKey: string; reason: string },
  actor: AdminActor,
): Promise<MovementResult> {
  const existing = await existingForKey(tx, input.idempotencyKey);
  if (existing) {
    if (existing.reversesMovementId !== input.movementId || existing.reason !== input.reason) {
      throw new TreasuryError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another movement');
    }
    return { movement: existing, created: false };
  }
  const [original] = await tx
    .select()
    .from(treasuryMovements)
    .where(eq(treasuryMovements.id, input.movementId));
  if (!original) throw new TreasuryError('NOT_FOUND', 'No such movement');
  if (original.reversesMovementId !== null) {
    throw new TreasuryError('MOVEMENT_NOT_REVERSIBLE', 'A reversal cannot be reversed');
  }
  await lockAccounts(tx, [original.fromAccountId, original.toAccountId]);
  const [reversed] = await tx
    .select({ id: treasuryMovements.id })
    .from(treasuryMovements)
    .where(eq(treasuryMovements.reversesMovementId, original.id));
  if (reversed) {
    throw new TreasuryError('MOVEMENT_ALREADY_REVERSED', 'The movement was already reversed', {
      movementId: reversed.id,
    });
  }
  const endpoints = await endpointsOf(tx, original);
  // A USDT receipt a standing return names stays (Q30): reversed, it would free the TXID for a
  // deposit claim of money already sent back. The return is reversed first.
  const receiptPlace = endpoints.to;
  if (
    original.outsideCategory === 'unclaimed_receipt' &&
    original.externalReference !== null &&
    (receiptPlace === 'usdt_trc20' || receiptPlace === 'usdt_bep20')
  ) {
    await lockPaymentReference(tx, receiptPlace, original.externalReference);
    if (
      await standingMovement(
        tx,
        'return_to_sender',
        original.toAccountId,
        original.externalReference,
      )
    ) {
      throw new TreasuryError('RECEIPT_RETURNED', 'A standing return names the receipt');
    }
  }
  const id = newId();
  const journalId = await postMovementJournal(
    tx,
    id,
    { ...endpoints, sentUnits: original.sentUnits, receivedUnits: original.receivedUnits },
    true,
  );
  const [movement] = await tx
    .insert(treasuryMovements)
    .values({
      id,
      kind: original.kind,
      fromAccountId: original.fromAccountId,
      sentUnits: original.sentUnits,
      sentCurrency: original.sentCurrency,
      toAccountId: original.toAccountId,
      receivedUnits: original.receivedUnits,
      receivedCurrency: original.receivedCurrency,
      rate: original.rate,
      outsideCategory: original.outsideCategory,
      openingBalance: false,
      orderId: original.orderId,
      externalReference: null,
      reason: input.reason,
      reversesMovementId: original.id,
      journalId,
      idempotencyKey: input.idempotencyKey,
      adminId: actor.adminId,
    })
    .returning();
  if (!movement) throw new Error('The reversal was not written');
  await recordAudit(tx, {
    ...auditEntry(actor, id, input.reason),
    action: 'treasury_movement.reversed',
    details: { ...auditMovement(movement, endpoints), reversedMovementId: original.id },
  });
  return { movement, created: true };
}
