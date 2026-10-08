import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateShamCashDeposit,
  type Currency,
  type CursorQuery,
  DEPOSIT_CREATIONS_PER_HOUR,
  DEPOSIT_FLAG_DETAILS,
  DEPOSIT_PENDING_HOURS,
  type Deposit,
  type DepositFlagCode,
  type DepositPage,
  depositCreditUsdUnits,
  depositLimitBreach,
  depositLimits,
  MAX_DEPOSITS_IN_REVIEW,
  QUOTE_LOCK_MINUTES,
  type QuoteOffer,
  RECEIPT_SIMILAR_MAX_DISTANCE,
  RECEIPT_UPLOADS_PER_HOUR,
  REFERENCE_CODE_ALPHABET,
  REFERENCE_CODE_LENGTH,
  REFERENCE_CODE_PREFIX,
  rateFromNumeric,
  type ShamCashOptions,
} from '@vertex-digital/contracts';
import {
  type Database,
  depositFlags,
  depositReceipts,
  deposits,
  newId,
  recordAudit,
  type Transaction,
} from '@vertex-digital/db';
import { and, count, desc, eq, ne, type SQL, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AuthService, withinLimits } from '../auth/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { type CurrentRate, RatesService } from '../rates/index.js';
import {
  customerDeposit,
  type DepositRow,
  isUuid,
  lockDeposit,
  notFound,
  stateConflict,
} from './deposit-records.js';
import { type CurrentSettings, DepositSettingsService } from './deposit-settings.service.js';

/** Thrown inside the create transaction when its key committed first: answered as a replay. */
class AlreadyCreated extends Error {}

const HOUR_MS = 60 * 60 * 1000;

const rateLimited = () =>
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

/**
 * The customer's Sham Cash deposits (S03 rules SC1–SC14, FL1–FL5): options, creation, requote,
 * receipt submission and cancellation. Every change locks the deposit row and writes its audit
 * entry in the same transaction; customers only ever reach their own deposits.
 */
@Injectable()
export class DepositsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly settings: DepositSettingsService,
    private readonly rates: RatesService,
    private readonly customers: AuthService,
    private readonly files: FilesService,
  ) {}

  /** `GET /api/deposits/sham-cash/options` (rules SC1, SC3, SC13, FX8). */
  async options(customerId: string): Promise<ShamCashOptions> {
    const [settings, rate, [pending]] = await Promise.all([
      this.settings.current(),
      this.rates.current(),
      this.db
        .select({ id: deposits.id })
        .from(deposits)
        .where(and(eq(deposits.customerId, customerId), eq(deposits.status, 'pending'))),
    ]);
    const option = (currency: Currency) => {
      const reason = unavailableReason(settings, rate, currency);
      return { available: reason === null, reason };
    };
    return {
      currencies: { SYP: option('SYP'), USD: option('USD') },
      account: settings && {
        name: settings.shamCashAccountName,
        number: settings.shamCashAccountNumber,
      },
      limits: settings && (await this.limitsOf(this.db, customerId, settings)),
      rate: rate && {
        id: rate.id,
        sypPerUsd: rate.sypPerUsd,
        displayStepSypUnits: rate.displayStepSypUnits,
      },
      reviewHours: settings && { start: settings.reviewHoursStart, end: settings.reviewHoursEnd },
      eta: await this.settings.eta(settings),
      pendingDepositId: pending?.id ?? null,
    };
  }

  /** `GET /api/deposits/sham-cash/qr/:currency`: the QR image of an enabled currency. */
  async qr(currency: string): Promise<ServedFile> {
    const settings = await this.settings.current();
    const fileId =
      currency === 'SYP' && settings?.sypEnabled
        ? settings.sypQrFileId
        : currency === 'USD' && settings?.usdEnabled
          ? settings.usdQrFileId
          : null;
    const file = fileId && (await this.files.serve(fileId, 'sham_cash_qr'));
    if (!file) throw new CodedException(404, 'NOT_FOUND', 'No QR image for this currency');
    return file;
  }

  /** `POST /api/deposits/sham-cash` (rules SC1–SC6): `created` false on a replay. */
  async create(
    customerId: string,
    idempotencyKey: string,
    input: CreateShamCashDeposit,
    meta: RequestMeta,
  ): Promise<{ deposit: Deposit; created: boolean }> {
    const replayed = await this.replay(customerId, idempotencyKey, input);
    if (replayed) return { deposit: replayed, created: false };

    const [settings, rate] = await Promise.all([this.settings.current(), this.rates.current()]);
    const reason = unavailableReason(settings, rate, input.currency);
    if (reason === 'no_rate') {
      throw new CodedException(409, 'RATE_UNAVAILABLE', 'No exchange rate yet');
    }
    if (reason || !settings) {
      throw new CodedException(409, 'DEPOSIT_METHOD_UNAVAILABLE', 'Not available now', {
        currency: input.currency,
      });
    }
    const quote = input.currency === 'SYP' ? rate : null;
    const declaredUsdUnits = depositCreditUsdUnits(
      input.currency,
      input.amountUnits,
      quote?.sypPerUsd ?? null,
    );
    try {
      const row = await this.db.transaction(async (tx) => {
        // A customer's creations queue here, so the one-pending, in-review and daily-limit checks
        // see each other's deposits.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deposits:${customerId}`}))`);
        const [written] = await tx
          .select({ id: deposits.id })
          .from(deposits)
          .where(eq(deposits.idempotencyKey, idempotencyKey));
        if (written) throw new AlreadyCreated();
        await this.checkCreation(tx, customerId);
        const limits = await this.limitsOf(tx, customerId, settings);
        const breach = depositLimitBreach(limits, declaredUsdUnits);
        if (breach) {
          throw new CodedException(422, 'DEPOSIT_LIMIT_EXCEEDED', 'Outside the limits', breach);
        }
        const created = await this.insertDeposit(tx, {
          customerId,
          method: 'sham_cash',
          currency: input.currency,
          declaredAmountUnits: input.amountUnits,
          declaredUsdUnits,
          idempotencyKey,
          ...(quote && {
            rateId: quote.id,
            rate: quote.sypPerUsd,
            quoteExpiresAt: sql`now() + make_interval(mins => ${QUOTE_LOCK_MINUTES})`,
          }),
          expiresAt: sql`now() + make_interval(hours => ${DEPOSIT_PENDING_HOURS})`,
        });
        await recordAudit(tx, {
          ...customerEntry(customerId, created.id, meta),
          action: 'deposit.created',
          details: {
            depositId: created.id,
            method: created.method,
            currency: created.currency,
            declaredAmountUnits: created.declaredAmountUnits,
            declaredUsdUnits: created.declaredUsdUnits,
            rateId: created.rateId,
          },
        });
        return created;
      });
      return { deposit: await this.view(row, settings), created: true };
    } catch (error) {
      if (error instanceof AlreadyCreated || isUniqueViolation(error)) {
        const again = await this.replay(customerId, idempotencyKey, input);
        if (again) return { deposit: again, created: false };
      }
      throw error;
    }
  }

  /** `GET /api/deposits`: the customer's deposits, newest first. */
  async list(customerId: string, query: CursorQuery): Promise<DepositPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.db
      .select({ row: deposits, at: cursorTime(deposits.createdAt) })
      .from(deposits)
      .where(
        and(
          eq(deposits.customerId, customerId),
          cursor ? after(deposits.createdAt, deposits.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(deposits.createdAt), desc(deposits.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, ({ row, at }) => ({ at, id: row.id }));
    const settings = await this.settings.current();
    const submitted = page.items.some(({ row }) => row.status === 'submitted');
    const eta = submitted ? await this.settings.eta(settings) : null;
    return {
      items: page.items.map(({ row }) => customerDeposit(row, { settings, eta })),
      nextCursor: page.nextCursor,
    };
  }

  /** `GET /api/deposits/:id`: the customer's own deposit only. */
  async read(customerId: string, id: string): Promise<Deposit> {
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(deposits)
          .where(and(eq(deposits.id, id), eq(deposits.customerId, customerId)))
      : [];
    if (!row) throw notFound();
    return this.view(row);
  }

  /** `POST /api/deposits/:id/quote` (rule SC10): the current rate for an unfixed SYP deposit. */
  async requote(customerId: string, id: string, meta: RequestMeta): Promise<Deposit> {
    const row = await this.db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id, eq(deposits.customerId, customerId));
      if (!(await isOpen(tx, deposit))) throw stateConflict(openStatus(deposit));
      if (deposit.currency !== 'SYP' || deposit.rateFixedAt) throw stateConflict(deposit.status);
      const rate = await this.currentRateOrRefuse();
      const declaredUsdUnits = depositCreditUsdUnits(
        'SYP',
        deposit.declaredAmountUnits,
        rate.sypPerUsd,
      );
      const [updated] = await tx
        .update(deposits)
        .set({
          rateId: rate.id,
          rate: rate.sypPerUsd,
          quoteExpiresAt: sql`now() + make_interval(mins => ${QUOTE_LOCK_MINUTES})`,
          declaredUsdUnits,
        })
        .where(eq(deposits.id, deposit.id))
        .returning();
      if (!updated) throw new Error(`Deposit ${deposit.id} was not requoted`);
      await recordAudit(tx, {
        ...customerEntry(customerId, deposit.id, meta),
        action: 'deposit.requoted',
        details: {
          depositId: deposit.id,
          before: quoteOf(deposit),
          after: quoteOf(updated),
        },
      });
      return updated;
    });
    return this.view(row);
  }

  /**
   * `POST /api/deposits/:id/receipt` (rules SC8, SC9, FL1–FL5): the image is re-encoded and
   * written first; its row, the receipt, the flags, the move to `submitted` and the audit entry
   * commit together.
   */
  async submitReceipt(
    customerId: string,
    id: string,
    upload: Buffer | undefined,
    rateId: string | undefined,
    meta: RequestMeta,
  ): Promise<Deposit> {
    // Every attempt counts, refused or not: an upload costs a decode and a file (rule SC6).
    const allowed = await withinLimits(this.db, [
      { key: `deposit-receipt:${customerId}`, max: RECEIPT_UPLOADS_PER_HOUR, windowMs: HOUR_MS },
    ]);
    if (!allowed) throw rateLimited();
    // Refused before the image is decoded or written: only an open deposit gets a file.
    const [current] = isUuid(id)
      ? await this.db
          .select()
          .from(deposits)
          .where(and(eq(deposits.id, id), eq(deposits.customerId, customerId)))
      : [];
    if (!current) throw notFound();
    await this.checkSubmittable(this.db, current, rateId);
    const prepared = await this.files.prepare('deposit_receipt', upload);
    const [settings, sharedWith] = await Promise.all([
      this.settings.current(),
      this.customers.sharingPhone(customerId),
    ]);
    const row = await this.db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id, eq(deposits.customerId, customerId));
      // Again under the lock: the expiry job or a requote may have committed meanwhile.
      const fixing = await this.checkSubmittable(tx, deposit, rateId);
      const fileId = await this.files.record(tx, prepared);
      const [receipt] = await tx
        .insert(depositReceipts)
        .values({
          id: newId(),
          depositId: deposit.id,
          fileId,
          originalSha256: prepared.originalSha256,
          perceptualHash: prepared.perceptualHash,
        })
        .returning();
      if (!receipt) throw new Error(`Receipt of deposit ${deposit.id} was not written`);
      const flags = await this.submissionFlags(tx, deposit, receipt, settings, sharedWith);
      if (flags.length > 0) {
        await tx.insert(depositFlags).values(
          flags.map((flag) => ({
            id: newId(),
            depositId: deposit.id,
            receiptId: receipt.id,
            code: flag.code,
            details: DEPOSIT_FLAG_DETAILS[flag.code].parse(flag.details),
          })),
        );
      }
      const [updated] = await tx
        .update(deposits)
        .set({
          status: 'submitted',
          submittedAt: sql`now()`,
          ...(fixing && { rateFixedAt: sql`now()` }),
        })
        .where(eq(deposits.id, deposit.id))
        .returning();
      if (!updated) throw new Error(`Deposit ${deposit.id} was not submitted`);
      await recordAudit(tx, {
        ...customerEntry(customerId, deposit.id, meta),
        action: 'deposit.submitted',
        details: {
          depositId: deposit.id,
          receiptId: receipt.id,
          rateFixed: updated.rateFixedAt !== null,
          flags: flags.map((flag) => flag.code),
        },
      });
      return updated;
    });
    return this.view(row, settings);
  }

  /** `POST /api/deposits/:id/cancel` (rule SC11): only before a receipt. */
  async cancel(customerId: string, id: string, meta: RequestMeta): Promise<Deposit> {
    const row = await this.db.transaction(async (tx) => {
      const deposit = await lockDeposit(tx, id, eq(deposits.customerId, customerId));
      if (deposit.status !== 'pending') throw stateConflict(deposit.status);
      const [updated] = await tx
        .update(deposits)
        .set({ status: 'cancelled' })
        .where(eq(deposits.id, deposit.id))
        .returning();
      if (!updated) throw new Error(`Deposit ${deposit.id} was not cancelled`);
      await recordAudit(tx, {
        ...customerEntry(customerId, deposit.id, meta),
        action: 'deposit.cancelled',
        details: { depositId: deposit.id },
      });
      return updated;
    });
    return this.view(row);
  }

  /** The customer's view, with the current settings and ETA where its status shows them. */
  private async view(row: DepositRow, known?: CurrentSettings | null): Promise<Deposit> {
    const settings = known === undefined ? await this.settings.current() : known;
    const eta = row.status === 'submitted' ? await this.settings.eta(settings) : null;
    return customerDeposit(row, { settings, eta });
  }

  /** The first deposit of an earlier request with this key, or null; another body is refused. */
  private async replay(
    customerId: string,
    idempotencyKey: string,
    input: CreateShamCashDeposit,
  ): Promise<Deposit | null> {
    const [row] = await this.db
      .select()
      .from(deposits)
      .where(eq(deposits.idempotencyKey, idempotencyKey));
    if (!row) return null;
    if (
      row.customerId !== customerId ||
      row.currency !== input.currency ||
      row.declaredAmountUnits !== input.amountUnits
    ) {
      throw new CodedException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was used for another request',
      );
    }
    return this.view(row);
  }

  /** Rules SC4, SC5, SC6: one pending, at most 3 in review, 10 creations an hour. */
  private async checkCreation(tx: Transaction, customerId: string): Promise<void> {
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
  private async limitsOf(
    db: Database | Transaction,
    customerId: string,
    settings: CurrentSettings,
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
  private async insertDeposit(
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

  private async currentRateOrRefuse(): Promise<CurrentRate> {
    const rate = await this.rates.current();
    if (!rate) throw new CodedException(409, 'RATE_UNAVAILABLE', 'No exchange rate yet');
    return rate;
  }

  /**
   * Rules SC8, SC9: a receipt goes to an open `pending` deposit; an unfixed SYP deposit also
   * needs a valid quote and the rate the customer saw. True when this submission fixes the rate.
   */
  private async checkSubmittable(
    db: Database | Transaction,
    deposit: DepositRow,
    rateId: string | undefined,
  ): Promise<boolean> {
    if (!(await isOpen(db, deposit))) throw stateConflict(openStatus(deposit));
    const fixing = deposit.currency === 'SYP' && deposit.rateFixedAt === null;
    if (fixing) {
      const valid = await isTrue(db, deposit.id, sql`${deposits.quoteExpiresAt} > now()`);
      if (!valid || rateId !== deposit.rateId) await this.refuseExpiredQuote(deposit);
    }
    return fixing;
  }

  /** Rule SC9: the customer sees the current rate and what the pounds would get, then accepts. */
  private async refuseExpiredQuote(deposit: DepositRow): Promise<never> {
    const rate = await this.currentRateOrRefuse();
    const offer: QuoteOffer = {
      rateId: rate.id,
      rate: rate.sypPerUsd,
      declaredUsdUnits: depositCreditUsdUnits('SYP', deposit.declaredAmountUnits, rate.sypPerUsd),
    };
    throw new CodedException(409, 'QUOTE_EXPIRED', 'The quote expired; accept a new one', offer);
  }

  /** Rules FL1–FL5, for the receipt just written. */
  private async submissionFlags(
    tx: Transaction,
    deposit: DepositRow,
    receipt: typeof depositReceipts.$inferSelect,
    settings: CurrentSettings | null,
    sharedWith: string[],
  ): Promise<{ code: DepositFlagCode; details: unknown }[]> {
    const flags: { code: DepositFlagCode; details: unknown }[] = [];
    const others = and(
      ne(depositReceipts.depositId, deposit.id),
      ne(depositReceipts.id, receipt.id),
    );
    const matchColumns = {
      depositId: depositReceipts.depositId,
      receiptId: depositReceipts.id,
      customerId: deposits.customerId,
    };
    const reused = await tx
      .select(matchColumns)
      .from(depositReceipts)
      .innerJoin(deposits, eq(deposits.id, depositReceipts.depositId))
      .where(and(others, eq(depositReceipts.originalSha256, receipt.originalSha256)))
      .orderBy(depositReceipts.createdAt)
      .limit(20);
    if (reused.length > 0) flags.push({ code: 'receipt_reused', details: { matches: reused } });
    // A linear scan: fine at V1 volumes (rule FL2).
    const distance = sql<number>`bit_count(int8send(${depositReceipts.perceptualHash} # ${receipt.perceptualHash}))::int`;
    const similar = await tx
      .select({ ...matchColumns, distance })
      .from(depositReceipts)
      .innerJoin(deposits, eq(deposits.id, depositReceipts.depositId))
      .where(
        and(
          others,
          ne(depositReceipts.originalSha256, receipt.originalSha256),
          sql`${distance} <= ${RECEIPT_SIMILAR_MAX_DISTANCE}`,
        ),
      )
      .orderBy(distance, depositReceipts.createdAt)
      .limit(20);
    if (similar.length > 0) flags.push({ code: 'receipt_similar', details: { matches: similar } });
    if (settings) {
      const limits = await this.limitsOf(tx, deposit.customerId, settings);
      if (!limits.established && deposit.declaredUsdUnits >= settings.flagNewAccountUsdUnits) {
        flags.push({
          code: 'new_account_large',
          details: {
            declaredUsdUnits: deposit.declaredUsdUnits,
            thresholdUnits: settings.flagNewAccountUsdUnits,
          },
        });
      }
      const [recent] = await tx
        .select({ count: count() })
        .from(depositReceipts)
        .innerJoin(deposits, eq(deposits.id, depositReceipts.depositId))
        .where(
          and(
            eq(deposits.customerId, deposit.customerId),
            sql`${depositReceipts.createdAt} > now() - interval '24 hours'`,
          ),
        );
      const submissions = recent?.count ?? 0;
      if (submissions > settings.flagVelocityCount) {
        flags.push({
          code: 'velocity',
          details: { submissions, threshold: settings.flagVelocityCount },
        });
      }
    }
    if (sharedWith.length > 0) {
      flags.push({
        code: 'shared_phone',
        details: { count: sharedWith.length, customerIds: sharedWith },
      });
    }
    return flags;
  }
}

/** Why a currency cannot be deposited (rules SC1, FX8), or null when it can. */
function unavailableReason(
  settings: CurrentSettings | null,
  rate: CurrentRate | null,
  currency: Currency,
): 'not_configured' | 'disabled' | 'no_rate' | null {
  if (!settings) return 'not_configured';
  if (!(currency === 'SYP' ? settings.sypEnabled : settings.usdEnabled)) return 'disabled';
  if (currency === 'SYP' && !rate) return 'no_rate';
  return null;
}

/**
 * A `pending` deposit not past `expires_at`: the worker may not have expired it yet (edge case
 * 19), so the database's clock decides.
 */
async function isOpen(tx: Database | Transaction, deposit: DepositRow): Promise<boolean> {
  return deposit.status === 'pending' && isTrue(tx, deposit.id, sql`${deposits.expiresAt} > now()`);
}

/** The status a refusal names: a `pending` deposit refused as not open is past its expiry. */
const openStatus = (deposit: DepositRow) =>
  deposit.status === 'pending' ? 'expired' : deposit.status;

/** A condition on the deposit's row, by the database's clock (time rules compare with `now()`). */
async function isTrue(
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

function quoteOf(row: DepositRow) {
  if (!row.rateId || !row.rate) throw new Error(`Deposit ${row.id} has no quote`);
  return {
    rateId: row.rateId,
    rate: rateFromNumeric(row.rate),
    declaredUsdUnits: row.declaredUsdUnits,
  };
}

function customerEntry(customerId: string, depositId: string, meta: RequestMeta) {
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
