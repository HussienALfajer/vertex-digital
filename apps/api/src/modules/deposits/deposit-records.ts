import {
  type Deposit,
  type DepositStatus,
  type ReviewEta,
  rateFromNumeric,
} from '@vertex-digital/contracts';
import { deposits, type Transaction } from '@vertex-digital/db';
import { and, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CodedException } from '../../core/errors/index.js';
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
 * shows the current settings while `pending` (rule SC7, edge case 10); `eta` while `submitted`.
 */
export function customerDeposit(
  row: DepositRow,
  context: { settings: CurrentSettings | null; eta: ReviewEta | null },
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
      row.status === 'pending' && settings
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
