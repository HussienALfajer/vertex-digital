import { randomInt } from 'node:crypto';
import {
  DEPOSIT_CREATIONS_PER_HOUR,
  type Deposit,
  type DepositLimitSettings,
  type DepositStatus,
  type DepositUsdt,
  depositLimits,
  MAX_DEPOSITS_IN_REVIEW,
  REFERENCE_CODE_ALPHABET,
  REFERENCE_CODE_LENGTH,
  REFERENCE_CODE_PREFIX,
  type ReviewEta,
  rateFromNumeric,
} from '@vertex-digital/contracts';
import { type Database, deposits, newId, type Transaction } from '@vertex-digital/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import type { CurrentSettings } from './deposit-settings.service.js';

/*
 * What the deposit services share: the row lock every transition takes, the refusals, and the
 * customer's view of a deposit.
 */

export type DepositRow = typeof deposits.$inferSelect;

export const isUuid = (value: string) => z.uuid().safeParse(value).success;

export const notFound = () => new CodedException(404, 'NOT_FOUND', 'No such deposit');

/** A move the transition table does not allow from the current status. */
export const stateConflict = (status: DepositStatus) =>
  new CodedException(409, 'DEPOSIT_STATE_CONFLICT', `The deposit is ${status}`, { status });

/**
 * Locks the deposit for its transition (`SELECT … FOR UPDATE`): parallel changes queue, and each
 * sees the status the one before it left. `scope` narrows it, to the customer's own deposits.
 */
export async function lockDeposit(tx: Transaction, id: string, scope?: SQL): Promise<DepositRow> {
  const [row] = isUuid(id)
    ? await tx
        .select()
        .from(deposits)
        .where(and(eq(deposits.id, id), scope))
        .for('update')
    : [];
  if (!row) throw notFound();
  return row;
}

/** The QR image of a currency, served to signed-in customers while it is enabled. */
export const qrUrl = (currency: 'SYP' | 'USD') => `/api/deposits/sham-cash/qr/${currency}`;

/**
 * A deposit as its customer sees it (no flags, transaction number or internal notes). `payTo`
 * shows the current settings while a Sham Cash deposit is `pending` (rule SC7, edge case 10);
 * `eta` while `submitted`; `usdt` the payment and check of a USDT deposit (S04).
 */
export function customerDeposit(
  row: DepositRow,
  context: { settings: CurrentSettings | null; eta: ReviewEta | null; usdt: DepositUsdt | null },
): Deposit {
  const { settings } = context;
  const enabled = settings && (row.currency === 'SYP' ? settings.sypEnabled : settings.usdEnabled);
  return {
    ...depositFacts(row),
    rateFixed: row.rateFixedAt !== null,
    receiptRequest: row.receiptRequestedAt && {
      at: row.receiptRequestedAt.toISOString(),
      note: row.receiptRequestNote,
    },
    payTo:
      row.status === 'pending' && row.method === 'sham_cash' && settings
        ? {
            accountName: settings.shamCashAccountName,
            accountNumber: settings.shamCashAccountNumber,
            qrUrl: enabled ? qrUrl(row.currency) : null,
          }
        : null,
    eta: row.status === 'submitted' ? context.eta : null,
    credited:
      row.status === 'credited' && row.receivedCurrency && row.receivedAmountUnits !== null
        ? {
            usdUnits: row.creditedUsdUnits ?? 0,
            receivedCurrency: row.receivedCurrency,
            receivedAmountUnits: row.receivedAmountUnits,
            rate: row.creditRate && rateFromNumeric(row.creditRate),
          }
        : null,
    rejection: row.rejectReason && { reason: row.rejectReason, note: row.customerNote },
    usdt: context.usdt,
  };
}

/** The fields every view of a deposit shows. */
export function depositFacts(row: DepositRow) {
  return {
    id: row.id,
    method: row.method,
    status: row.status,
    referenceCode: row.referenceCode,
    currency: row.currency,
    declaredAmountUnits: row.declaredAmountUnits,
    declaredUsdUnits: row.declaredUsdUnits,
    quote:
      row.rateId && row.rate && row.quoteExpiresAt
        ? {
            rateId: row.rateId,
            rate: rateFromNumeric(row.rate),
            expiresAt: row.quoteExpiresAt.toISOString(),
          }
        : null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** Thrown inside a create transaction when its key committed first: answered as a replay. */
export class AlreadyCreated extends Error {}

export const rateLimited = () =>
  new CodedException(429, 'RATE_LIMITED', 'Too many deposit requests; retry later');

/** A new reference code from a CSPRNG (`randomInt` is uniform over the alphabet). */
const newReferenceCode = () =>
  REFERENCE_CODE_PREFIX +
  Array.from(
    { length: REFERENCE_CODE_LENGTH },
    () => REFERENCE_CODE_ALPHABET[randomInt(REFERENCE_CODE_ALPHABET.length)],
  ).join('');

/** Attempts at a free reference code: 31⁵ codes make a second attempt already rare. */
const REFERENCE_CODE_ATTEMPTS = 5;

/** Serializes a customer's creations, so the one-pending, in-review and limit checks see each other. */
export const lockCustomerCreations = (tx: Transaction, customerId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deposits:${customerId}`}))`);

/** Rules SC4, SC5, SC6: one pending, at most 3 in review, 10 creations an hour. */
export async function checkCreation(tx: Transaction, customerId: string): Promise<void> {
  const rows = await tx
    .select({
      pendingId: sql<
        string | null
      >`(array_agg(${deposits.id}) filter (where ${deposits.status} = 'pending'))[1]`,
      submitted: sql<number>`(count(*) filter (where ${deposits.status} = 'submitted'))::int`,
      lastHour: sql<number>`(count(*) filter (where ${deposits.createdAt} > now() - interval '1 hour'))::int`,
    })
    .from(deposits)
    .where(eq(deposits.customerId, customerId));
  const [state] = rows;
  if (state?.pendingId) {
    throw new CodedException(409, 'DEPOSIT_ALREADY_PENDING', 'A deposit awaits its receipt', {
      depositId: state.pendingId,
    });
  }
  if ((state?.submitted ?? 0) >= MAX_DEPOSITS_IN_REVIEW) {
    throw new CodedException(409, 'TOO_MANY_DEPOSITS_IN_REVIEW', 'Too many deposits in review');
  }
  if ((state?.lastHour ?? 0) >= DEPOSIT_CREATIONS_PER_HOUR) throw rateLimited();
}

/** Rule SC3: new or established, and what the last 24 hours used. */
export async function limitsOf(
  db: Database | Transaction,
  customerId: string,
  settings: DepositLimitSettings,
) {
  const [row] = await db
    .select({
      established: sql<boolean>`bool_or(${deposits.status} = 'credited')`,
      used: sql<string>`coalesce(sum(case
        when ${deposits.status} in ('pending', 'submitted') then ${deposits.declaredUsdUnits}
        when ${deposits.status} = 'credited' then ${deposits.creditedUsdUnits}
        else 0 end) filter (where ${deposits.createdAt} > now() - interval '24 hours'), 0)::text`,
    })
    .from(deposits)
    .where(eq(deposits.customerId, customerId));
  return depositLimits(settings, row?.established ?? false, Number(row?.used ?? 0));
}

/** Inserts the deposit, drawing another reference code on the rare collision. */
export async function insertDeposit(
  tx: Transaction,
  values: Omit<PgInsertValue<typeof deposits>, 'id' | 'referenceCode'>,
): Promise<DepositRow> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // A savepoint: a collision leaves the transaction usable for the next attempt.
      const [row] = await tx.transaction((step) =>
        step
          .insert(deposits)
          .values({ ...values, id: newId(), referenceCode: newReferenceCode() })
          .returning(),
      );
      if (!row) throw new Error('The deposit was not written');
      return row;
    } catch (error) {
      const constraint = (error as { cause?: { constraint?: string } }).cause?.constraint;
      if (constraint !== 'deposits_reference_code_unique' || attempt >= REFERENCE_CODE_ATTEMPTS) {
        throw error;
      }
    }
  }
}

export function customerEntry(customerId: string, depositId: string, meta: RequestMeta) {
  return {
    actorKind: 'customer',
    actorId: customerId,
    channel: 'store',
    entityType: 'deposit',
    entityId: depositId,
    reason: null,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  } as const;
}

/**
 * A `pending` deposit not past `expires_at`: the worker may not have expired it yet (edge case
 * 19), so the database's clock decides.
 */
export async function isOpen(tx: Database | Transaction, deposit: DepositRow): Promise<boolean> {
  return deposit.status === 'pending' && isTrue(tx, deposit.id, sql`${deposits.expiresAt} > now()`);
}

/** A condition on the deposit's row, by the database's clock (time rules compare with `now()`). */
export async function isTrue(
  tx: Database | Transaction,
  depositId: string,
  condition: SQL,
): Promise<boolean> {
  const [row] = await tx
    .select({ holds: sql<boolean>`coalesce(${condition}, false)` })
    .from(deposits)
    .where(eq(deposits.id, depositId));
  return row?.holds ?? false;
}
