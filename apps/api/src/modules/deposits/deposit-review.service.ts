import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminDeposit,
  type AdminDepositCounts,
  type AdminDepositPage,
  type AdminDepositQuery,
  type ApproveDeposit,
  approvalFlags,
  approvalNeedsReauthentication,
  DEPOSIT_FLAG_DETAILS,
  DEPOSIT_PENDING_HOURS,
  type DepositFlagCode,
  depositCreditUsdUnits,
  type EmailParams,
  type EmailTemplate,
  type RejectDeposit,
  type RequestReceipt,
  rateFromNumeric,
  referenceCodeSchema,
  sameFlags,
} from '@vertex-digital/contracts';
import {
  claimPaymentReference,
  type Database,
  depositFlags,
  depositReceipts,
  deposits,
  LedgerError,
  lockCustomerWallet,
  newId,
  type PaymentReferenceOwner,
  postDepositCredit,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { and, asc, count, desc, eq, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
import { isRecentlyReauthenticated } from '../../core/access/index.js';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AdminAuthService, type AdminIdentity } from '../admin/index.js';
import { AuthService } from '../auth/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { NotificationsService } from '../notifications/index.js';
import { RatesService } from '../rates/index.js';
import { WalletService } from '../wallet/index.js';
import {
  type DepositRow,
  depositFacts,
  isUuid,
  lockDeposit,
  notFound,
  stateConflict,
} from './deposit-records.js';
import { DepositSettingsService } from './deposit-settings.service.js';

/** Thrown inside a decision's transaction when its key decided first: answered as a replay. */
class AlreadyDecided extends Error {}

const keyReused = () =>
  new CodedException(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'The Idempotency-Key was used for another request',
  );

/**
 * True when the deposit has a flag, any receipt or none. The outer column is named in full:
 * Drizzle leaves the table off columns in a select list, where `id` would mean the flag's.
 */
const flagged = sql<boolean>`exists (select 1 from ${depositFlags} where ${depositFlags.depositId} = ${sql.identifier('deposits')}.${sql.identifier('id')})`;

/** The queue's cursor (rule RV10): flagged first, then oldest submission, then id. */
interface QueuePosition {
  flagged: boolean;
  at: string;
  id: string;
}

const encodeQueueCursor = (position: QueuePosition) =>
  Buffer.from(JSON.stringify(['q', position.flagged, position.at, position.id])).toString(
    'base64url',
  );

function decodeQueueCursor(cursor: string): QueuePosition {
  try {
    const [tag, isFlagged, at, id] = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown[];
    if (tag !== 'q' || typeof isFlagged !== 'boolean' || typeof at !== 'string') throw new Error();
    if (typeof id !== 'string' || !isUuid(id) || Number.isNaN(Date.parse(at))) throw new Error();
    return { flagged: isFlagged, at, id };
  } catch {
    throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid cursor', [
      { path: ['cursor'], message: 'Invalid cursor' },
    ]);
  }
}

/**
 * The admin's review of Sham Cash deposits (S03 rules RV1–RV10, M1–M5): the queue, a deposit's
 * full picture, and the decisions. An approval claims the transaction number, posts the credit,
 * raises the approval-time flags and writes its audit entry and email in one transaction.
 */
@Injectable()
export class DepositReviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly settings: DepositSettingsService,
    private readonly rates: RatesService,
    private readonly customers: AuthService,
    private readonly admins: AdminAuthService,
    private readonly wallets: WalletService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
  ) {}

  /** `GET /api/admin/deposits` (rule RV10). */
  async queue(query: AdminDepositQuery): Promise<AdminDepositPage> {
    const filters: (SQL | undefined)[] = [
      query.status === 'all' ? undefined : eq(deposits.status, query.status),
      query.flagged === 'true'
        ? flagged
        : query.flagged === 'false'
          ? sql`not ${flagged}`
          : undefined,
    ];
    if (query.q) {
      const code = referenceCodeSchema.safeParse(query.q);
      const customerIds = await this.customers.idsByEmailPrefix(query.q);
      const matches = [
        code.success ? eq(deposits.referenceCode, code.data) : undefined,
        customerIds.length > 0 ? inArray(deposits.customerId, customerIds) : undefined,
      ].filter((match) => match !== undefined);
      if (matches.length === 0) return { items: [], nextCursor: null };
      filters.push(or(...matches));
    }
    const review = query.status === 'submitted';
    const rows = review
      ? await this.reviewRows(filters, query)
      : await this.newestRows(filters, query);
    const ids = rows.items.map((row) => row.id);
    const [customers, flags] = await Promise.all([
      this.customers.depositCustomers([...new Set(rows.items.map((row) => row.customerId))]),
      this.flagCodes(ids),
    ]);
    return {
      items: rows.items.map((row) => {
        const customer = customers.get(row.customerId);
        if (!customer) throw new Error(`Deposit ${row.id} has no customer`);
        return {
          ...depositFacts(row),
          customer: {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            isTest: customer.isTest,
          },
          flags: flags.get(row.id) ?? [],
        };
      }),
      nextCursor: rows.nextCursor,
    };
  }

  /** `GET /api/admin/deposits/counts`: the navigation badge. */
  async counts(): Promise<AdminDepositCounts> {
    const [row] = await this.db
      .select({
        submitted: sql<number>`(count(*) filter (where ${deposits.status} = 'submitted'))::int`,
        submittedFlagged: sql<number>`(count(*) filter (where ${deposits.status} = 'submitted' and ${flagged}))::int`,
        pending: sql<number>`(count(*) filter (where ${deposits.status} = 'pending'))::int`,
      })
      .from(deposits)
      .where(inArray(deposits.status, ['submitted', 'pending']));
    return {
      submitted: row?.submitted ?? 0,
      submittedFlagged: row?.submittedFlagged ?? 0,
      pending: row?.pending ?? 0,
    };
  }

  /** `GET /api/admin/deposits/:id`. */
  async deposit(id: string): Promise<AdminDeposit> {
    const [row] = isUuid(id)
      ? await this.db.select().from(deposits).where(eq(deposits.id, id))
      : [];
    if (!row) throw notFound();
    return this.view(row);
  }

  /** `GET /api/admin/deposits/:id/receipts/:receiptId`: only the admin ever reads receipts. */
  async receipt(id: string, receiptId: string): Promise<ServedFile> {
    const [row] =
      isUuid(id) && isUuid(receiptId)
        ? await this.db
            .select({ fileId: depositReceipts.fileId })
            .from(depositReceipts)
            .where(and(eq(depositReceipts.id, receiptId), eq(depositReceipts.depositId, id)))
        : [];
    const file = row && (await this.files.serve(row.fileId, 'deposit_receipt'));
    if (!file) throw new CodedException(404, 'NOT_FOUND', 'No such receipt');
    return file;
  }

  /**
   * `POST /api/admin/deposits/:id/approve` (rules RV1–RV5, RV7, RV9): `created` false on a
   * replay of the same key and body.
   */
  async approve(
    admin: AdminIdentity,
    id: string,
    idempotencyKey: string,
    input: ApproveDeposit,
    meta: RequestMeta,
  ): Promise<{ deposit: AdminDeposit; created: boolean }> {
    const replayed = await this.replayApproval(id, idempotencyKey, input);
    if (replayed) return { deposit: replayed, created: false };
    const [current] = isUuid(id)
      ? await this.db.select().from(deposits).where(eq(deposits.id, id))
      : [];
    if (!current) throw notFound();
    if (current.status !== 'submitted') throw stateConflict(current.status);
    // Rule RV4, before anything is written: the credit and every flag the approval would carry.
    const plan = await this.planApproval(this.db, current, input);
    if (
      approvalNeedsReauthentication(plan.creditedUsdUnits, plan.expectedFlags.length) &&
      !isRecentlyReauthenticated(admin)
    ) {
      throw new CodedException(
        403,
        'REAUTHENTICATION_REQUIRED',
        'Confirm your password and code first',
      );
    }
    try {
      const row = await this.db.transaction(async (tx) => {
        // RV7, steps 1–2.
        const deposit = await lockDeposit(tx, id);
        if (deposit.decisionIdempotencyKey === idempotencyKey) throw new AlreadyDecided();
        if (deposit.status !== 'submitted') throw stateConflict(deposit.status);
        const approval = await this.planApproval(tx, deposit, input);
        if (!sameFlags(input.acknowledgedFlags, approval.expectedFlags)) {
          throw new CodedException(409, 'FLAGS_NOT_ACKNOWLEDGED', 'Acknowledge every flag', {
            expected: approval.expectedFlags,
          });
        }
        // Step 4 before step 3: the wallet is locked before the claim, in the order of the S02
        // adjustments, so an approval and a manual deposit for one customer queue, never deadlock.
        await lockCustomerWallet(tx, deposit.customerId);
        // Step 3: one claim per real transfer, across deposits and adjustments (rule SC14).
        try {
          await claimPaymentReference(tx, 'sham_cash', input.transactionNumber, {
            depositId: deposit.id,
          });
        } catch (error) {
          if (error instanceof LedgerError && error.code === 'EXTERNAL_REFERENCE_TAKEN') {
            throw referenceTaken(error.details as PaymentReferenceOwner | null);
          }
          throw error;
        }
        // Step 5: the journal (money flows M1, M2).
        const credit = await postDepositCredit(tx, {
          depositId: deposit.id,
          customerId: deposit.customerId,
          receivedCurrency: input.receivedCurrency,
          receivedAmountUnits: input.receivedAmountUnits,
          creditedUsdUnits: approval.creditedUsdUnits,
        });
        // Step 6.
        const [updated] = await tx
          .update(deposits)
          .set({
            status: 'credited',
            decidedAt: sql`now()`,
            transactionNumber: input.transactionNumber,
            receivedCurrency: input.receivedCurrency,
            receivedAmountUnits: input.receivedAmountUnits,
            creditedUsdUnits: approval.creditedUsdUnits,
            creditRateId: approval.rate?.id ?? null,
            creditRate: approval.rate?.value ?? null,
            referenceCheck: input.referenceCheck,
            journalId: credit.journalId,
            decisionIdempotencyKey: idempotencyKey,
            adminId: admin.id,
          })
          .where(eq(deposits.id, deposit.id))
          .returning();
        if (!updated) throw new Error(`Deposit ${deposit.id} was not credited`);
        // Step 7: the approval-time flags (rule RV5).
        if (approval.approvalFlags.length > 0) {
          await tx.insert(depositFlags).values(
            approval.approvalFlags.map((code) => ({
              id: newId(),
              depositId: deposit.id,
              code,
              details: DEPOSIT_FLAG_DETAILS[code].parse(
                code === 'amount_mismatch'
                  ? {
                      declaredCurrency: deposit.currency,
                      declaredAmountUnits: deposit.declaredAmountUnits,
                      receivedCurrency: input.receivedCurrency,
                      receivedAmountUnits: input.receivedAmountUnits,
                    }
                  : {},
              ),
            })),
          );
        }
        // Step 8.
        await recordAudit(tx, {
          ...adminEntry(admin.id, deposit.id, meta),
          action: 'deposit.credited',
          reason: input.internalNote ?? null,
          details: {
            depositId: deposit.id,
            customerId: deposit.customerId,
            transactionNumber: input.transactionNumber,
            receivedCurrency: input.receivedCurrency,
            receivedAmountUnits: input.receivedAmountUnits,
            creditedUsdUnits: approval.creditedUsdUnits,
            creditRateId: approval.rate?.id ?? null,
            referenceCheck: input.referenceCheck,
            acknowledgedFlags: approval.expectedFlags,
            journalId: credit.journalId,
            balanceAfterUnits: credit.balanceAfterUnits,
          },
        });
        // Step 9: the amount only; never the transaction number or a note (S01 email rule).
        await this.queueEmail(tx, updated, 'customer_deposit_credited', {
          at: (updated.decidedAt as Date).toISOString(),
          depositId: updated.id,
          referenceCode: updated.referenceCode,
          creditedUsdUnits: approval.creditedUsdUnits,
        });
        return updated;
      });
      // A02: paying `awaiting_balance` orders after a credit hooks in here, after the commit
      // (S08/S09). Nothing to do in S03.
      return { deposit: await this.view(row), created: true };
    } catch (error) {
      if (error instanceof AlreadyDecided || isUniqueViolation(error)) {
        const again = await this.replayApproval(id, idempotencyKey, input);
        if (again) return { deposit: again, created: false };
      }
      throw error;
    }
  }

  /** `POST /api/admin/deposits/:id/reject` (rules RV6, RV9, M4, M5). */
  async reject(
    adminId: string,
    id: string,
    idempotencyKey: string,
    input: RejectDeposit,
    meta: RequestMeta,
  ): Promise<{ deposit: AdminDeposit; created: boolean }> {
    const customerNote = input.customerNote ?? null;
    const replayed = await this.replayRejection(id, idempotencyKey, input.reason, customerNote);
    if (replayed) return { deposit: replayed, created: false };
    try {
      const row = await this.db.transaction(async (tx) => {
        const deposit = await lockDeposit(tx, id);
        if (deposit.decisionIdempotencyKey === idempotencyKey) throw new AlreadyDecided();
        if (deposit.status !== 'submitted') throw stateConflict(deposit.status);
        const [updated] = await tx
          .update(deposits)
          .set({
            status: 'rejected',
            decidedAt: sql`now()`,
            rejectReason: input.reason,
            customerNote,
            decisionIdempotencyKey: idempotencyKey,
            adminId,
          })
          .where(eq(deposits.id, deposit.id))
          .returning();
        if (!updated) throw new Error(`Deposit ${deposit.id} was not rejected`);
        await recordAudit(tx, {
          ...adminEntry(adminId, deposit.id, meta),
          action: 'deposit.rejected',
          reason: input.internalNote,
          details: {
            depositId: deposit.id,
            customerId: deposit.customerId,
            rejectReason: input.reason,
            customerNote,
          },
        });
        // The reason's words only; the note stays on the deposit page (rule RV6).
        await this.queueEmail(tx, updated, 'customer_deposit_rejected', {
          depositId: updated.id,
          referenceCode: updated.referenceCode,
          reason: input.reason,
        });
        return updated;
      });
      return { deposit: await this.view(row), created: true };
    } catch (error) {
      if (error instanceof AlreadyDecided || isUniqueViolation(error)) {
        const again = await this.replayRejection(id, idempotencyKey, input.reason, customerNote);
        if (again) return { deposit: again, created: false };
      }
      throw error;
    }
  }

  /** `POST /api/admin/deposits/:id/request-receipt` (rule RV8): once per deposit. */
  async requestReceipt(
    adminId: string,
    id: string,
    input: RequestReceipt,
    meta: RequestMeta,
  ): Promise<AdminDeposit> {
    const customerNote = input.customerNote ?? null;
    try {
      const row = await this.db.transaction(async (tx) => {
        const deposit = await lockDeposit(tx, id);
        if (deposit.status !== 'submitted') throw stateConflict(deposit.status);
        if (deposit.receiptRequestCount >= 1) {
          throw new CodedException(
            409,
            'RECEIPT_ALREADY_REQUESTED',
            'A clearer receipt was already requested',
          );
        }
        const [updated] = await tx
          .update(deposits)
          .set({
            status: 'pending',
            receiptRequestedAt: sql`now()`,
            receiptRequestCount: 1,
            receiptRequestNote: customerNote,
            expiresAt: sql`now() + make_interval(hours => ${DEPOSIT_PENDING_HOURS})`,
          })
          .where(eq(deposits.id, deposit.id))
          .returning();
        if (!updated) throw new Error(`Deposit ${deposit.id} was not sent back`);
        await recordAudit(tx, {
          ...adminEntry(adminId, deposit.id, meta),
          action: 'deposit.receipt_requested',
          reason: input.internalNote,
          details: { depositId: deposit.id, customerNote },
        });
        await this.queueEmail(tx, updated, 'customer_deposit_receipt_requested', {
          depositId: updated.id,
          referenceCode: updated.referenceCode,
        });
        return updated;
      });
      return this.view(row);
    } catch (error) {
      // The customer opened another pending deposit meanwhile (edge case 9): reject instead.
      if (
        (error as { cause?: { constraint?: string } }).cause?.constraint ===
        'deposits_one_pending_unique'
      ) {
        throw new CodedException(
          409,
          'DEPOSIT_ALREADY_PENDING',
          'The customer has another deposit awaiting a receipt',
        );
      }
      throw error;
    }
  }

  /**
   * What an approval would do (rules RV2, RV3, RV5): the rate for pounds received, the credit,
   * and every flag to acknowledge. Refuses a credit below one cent and pounds without a rate.
   */
  private async planApproval(
    db: Database | Transaction,
    deposit: DepositRow,
    input: ApproveDeposit,
  ) {
    let rate: { id: string; value: string } | null = null;
    if (input.receivedCurrency === 'SYP') {
      if (deposit.rateId && deposit.rate) {
        rate = { id: deposit.rateId, value: rateFromNumeric(deposit.rate) };
      } else {
        const current = await this.rates.current();
        if (!current) throw new CodedException(409, 'RATE_UNAVAILABLE', 'No exchange rate yet');
        rate = { id: current.id, value: current.sypPerUsd };
      }
    }
    const creditedUsdUnits = depositCreditUsdUnits(
      input.receivedCurrency,
      input.receivedAmountUnits,
      rate?.value ?? null,
    );
    if (creditedUsdUnits <= 0) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'The credit is below one cent', [
        { path: ['receivedAmountUnits'], message: 'Worth less than one cent' },
      ]);
    }
    const raised = await db
      .selectDistinct({ code: depositFlags.code })
      .from(depositFlags)
      .where(eq(depositFlags.depositId, deposit.id));
    const flagsAtApproval = approvalFlags(deposit, input);
    const expectedFlags = [...new Set([...raised.map((flag) => flag.code), ...flagsAtApproval])];
    return { rate, creditedUsdUnits, approvalFlags: flagsAtApproval, expectedFlags };
  }

  /** The credited deposit of an earlier approval with this key, or null; another body is refused. */
  private async replayApproval(
    id: string,
    idempotencyKey: string,
    input: ApproveDeposit,
  ): Promise<AdminDeposit | null> {
    const row = await this.decidedWith(idempotencyKey);
    if (!row) return null;
    const [flags] = await Promise.all([this.flagCodes([row.id])]);
    const same =
      row.id === id &&
      row.status === 'credited' &&
      row.transactionNumber === input.transactionNumber &&
      row.receivedCurrency === input.receivedCurrency &&
      row.receivedAmountUnits === input.receivedAmountUnits &&
      row.referenceCheck === input.referenceCheck &&
      sameFlags(input.acknowledgedFlags, flags.get(row.id) ?? []);
    if (!same) throw keyReused();
    return this.view(row);
  }

  private async replayRejection(
    id: string,
    idempotencyKey: string,
    reason: RejectDeposit['reason'],
    customerNote: string | null,
  ): Promise<AdminDeposit | null> {
    const row = await this.decidedWith(idempotencyKey);
    if (!row) return null;
    const same =
      row.id === id &&
      row.status === 'rejected' &&
      row.rejectReason === reason &&
      row.customerNote === customerNote;
    if (!same) throw keyReused();
    return this.view(row);
  }

  private async decidedWith(idempotencyKey: string): Promise<DepositRow | null> {
    const [row] = await this.db
      .select()
      .from(deposits)
      .where(eq(deposits.decisionIdempotencyKey, idempotencyKey));
    return row ?? null;
  }

  /** The decision's email to the deposit's customer, in the decision's transaction. */
  private async queueEmail<Template extends EmailTemplate>(
    tx: Transaction,
    deposit: DepositRow,
    template: Template,
    params: EmailParams<Template>,
  ): Promise<void> {
    const customer = (await this.customers.depositCustomers([deposit.customerId])).get(
      deposit.customerId,
    );
    if (!customer) throw new Error(`Deposit ${deposit.id} has no customer`);
    await this.notifications.queueEmail(tx, {
      to: customer.email,
      template,
      params,
      customerId: customer.id,
    });
  }

  /** Each deposit's distinct flag codes. */
  private async flagCodes(ids: string[]): Promise<Map<string, DepositFlagCode[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectDistinct({ depositId: depositFlags.depositId, code: depositFlags.code })
      .from(depositFlags)
      .where(inArray(depositFlags.depositId, ids))
      .orderBy(depositFlags.depositId, depositFlags.code);
    const codes = new Map<string, DepositFlagCode[]>();
    for (const row of rows)
      codes.set(row.depositId, [...(codes.get(row.depositId) ?? []), row.code]);
    return codes;
  }

  /** `submitted`: flagged first, then the oldest submission (rule RV10). */
  private async reviewRows(filters: (SQL | undefined)[], query: AdminDepositQuery) {
    const cursor = query.cursor ? decodeQueueCursor(query.cursor) : undefined;
    const position = cursor
      ? or(
          cursor.flagged ? sql`not ${flagged}` : sql`false`,
          and(
            cursor.flagged ? flagged : sql`not ${flagged}`,
            or(
              sql`${deposits.submittedAt} > ${cursor.at}::timestamptz`,
              and(
                sql`${deposits.submittedAt} = ${cursor.at}::timestamptz`,
                sql`${deposits.id} > ${cursor.id}`,
              ),
            ),
          ),
        )
      : undefined;
    const rows = await this.db
      .select({ row: deposits, isFlagged: flagged, at: cursorTime(deposits.submittedAt) })
      .from(deposits)
      .where(and(...filters, position))
      .orderBy(desc(flagged), asc(deposits.submittedAt), asc(deposits.id))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map(({ row }) => row),
      nextCursor:
        rows.length > query.limit && last
          ? encodeQueueCursor({ flagged: last.isFlagged, at: last.at, id: last.row.id })
          : null,
    };
  }

  /** Other statuses: newest first. */
  private async newestRows(filters: (SQL | undefined)[], query: AdminDepositQuery) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({ row: deposits, at: cursorTime(deposits.createdAt) })
      .from(deposits)
      .where(and(...filters, cursor ? after(deposits.createdAt, deposits.id, cursor) : undefined))
      .orderBy(desc(deposits.createdAt), desc(deposits.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ row, at }) => ({ at, id: row.id }));
    return { items: page.items.map(({ row }) => row), nextCursor: page.nextCursor };
  }

  /** Everything the review page shows of a deposit. */
  private async view(row: DepositRow): Promise<AdminDeposit> {
    const [customers, receipts, flags, history, balanceUnits, rate, settings, names] =
      await Promise.all([
        this.customers.depositCustomers([row.customerId]),
        this.db
          .select({ id: depositReceipts.id, createdAt: depositReceipts.createdAt })
          .from(depositReceipts)
          .where(eq(depositReceipts.depositId, row.id))
          .orderBy(asc(depositReceipts.createdAt), asc(depositReceipts.id)),
        this.db
          .select()
          .from(depositFlags)
          .where(eq(depositFlags.depositId, row.id))
          .orderBy(asc(depositFlags.createdAt), asc(depositFlags.code)),
        this.customerHistory(row.customerId, row.id),
        this.wallets.balanceOf(row.customerId),
        this.rates.current(),
        this.settings.current(),
        this.admins.namesOf(row.adminId ? [row.adminId] : []),
      ]);
    const customer = customers.get(row.customerId);
    if (!customer) throw new Error(`Deposit ${row.id} has no customer`);
    return {
      ...depositFacts(row),
      rateFixedAt: row.rateFixedAt?.toISOString() ?? null,
      receiptRequestedAt: row.receiptRequestedAt?.toISOString() ?? null,
      receiptRequestCount: row.receiptRequestCount,
      receiptRequestNote: row.receiptRequestNote,
      approvalRate:
        row.rateId && row.rate
          ? { rateId: row.rateId, rate: rateFromNumeric(row.rate) }
          : rate && { rateId: rate.id, rate: rate.sypPerUsd },
      adminName: (row.adminId && names.get(row.adminId)) ?? null,
      credit:
        row.status === 'credited' &&
        row.transactionNumber &&
        row.receivedCurrency &&
        row.receivedAmountUnits &&
        row.creditedUsdUnits &&
        row.referenceCheck &&
        row.journalId
          ? {
              transactionNumber: row.transactionNumber,
              receivedCurrency: row.receivedCurrency,
              receivedAmountUnits: row.receivedAmountUnits,
              creditedUsdUnits: row.creditedUsdUnits,
              creditRateId: row.creditRateId,
              creditRate: row.creditRate && rateFromNumeric(row.creditRate),
              referenceCheck: row.referenceCheck,
              journalId: row.journalId,
            }
          : null,
      rejection: row.rejectReason && { reason: row.rejectReason, customerNote: row.customerNote },
      receipts: receipts.map((receipt) => ({
        id: receipt.id,
        createdAt: receipt.createdAt.toISOString(),
      })),
      flags: flags.map((flag) => ({
        id: flag.id,
        code: flag.code,
        receiptId: flag.receiptId,
        details: flag.details as Record<string, unknown>,
        createdAt: flag.createdAt.toISOString(),
      })),
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        isTest: customer.isTest,
        createdAt: customer.createdAt.toISOString(),
        established: history.creditedCount > 0,
        creditedCount: history.creditedCount,
        creditedTotalUsdUnits: history.creditedTotalUsdUnits,
        balanceUnits,
        recentDeposits: history.recent,
      },
      eta: row.status === 'submitted' ? await this.settings.eta(settings) : null,
    };
  }

  /** The customer's credited totals and last 10 other deposits (edge case 16). */
  private async customerHistory(customerId: string, exceptId: string) {
    const [[totals], recent] = await Promise.all([
      this.db
        .select({
          creditedCount: count(),
          total: sql<string>`coalesce(sum(${deposits.creditedUsdUnits}), 0)::text`,
        })
        .from(deposits)
        .where(and(eq(deposits.customerId, customerId), eq(deposits.status, 'credited'))),
      this.db
        .select({
          id: deposits.id,
          referenceCode: deposits.referenceCode,
          status: deposits.status,
          currency: deposits.currency,
          declaredAmountUnits: deposits.declaredAmountUnits,
          createdAt: deposits.createdAt,
        })
        .from(deposits)
        .where(and(eq(deposits.customerId, customerId), ne(deposits.id, exceptId)))
        .orderBy(desc(deposits.createdAt), desc(deposits.id))
        .limit(10),
    ]);
    return {
      creditedCount: totals?.creditedCount ?? 0,
      creditedTotalUsdUnits: Number(totals?.total ?? 0),
      recent: recent.map((deposit) => ({ ...deposit, createdAt: deposit.createdAt.toISOString() })),
    };
  }
}

/** `details` names the record that holds the transaction number (rule SC14). */
const referenceTaken = (owner: PaymentReferenceOwner | null) =>
  new CodedException(
    409,
    'EXTERNAL_REFERENCE_TAKEN',
    'The transaction number is already recorded',
    owner ?? undefined,
  );

function adminEntry(adminId: string, depositId: string, meta: RequestMeta) {
  return {
    actorKind: 'admin',
    actorId: adminId,
    channel: 'admin',
    entityType: 'deposit',
    entityId: depositId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  } as const;
}
