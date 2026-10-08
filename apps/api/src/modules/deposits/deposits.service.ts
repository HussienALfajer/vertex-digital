import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateShamCashDeposit,
  type Currency,
  type CursorQuery,
  DEPOSIT_FLAG_DETAILS,
  DEPOSIT_PENDING_HOURS,
  type Deposit,
  type DepositFlagCode,
  type DepositPage,
  depositCreditUsdUnits,
  depositLimitBreach,
  depositMethodState,
  QUOTE_LOCK_MINUTES,
  type QuoteOffer,
  RECEIPT_SIMILAR_MAX_DISTANCE,
  RECEIPT_UPLOADS_PER_HOUR,
  rateFromNumeric,
  type ShamCashOptions,
} from '@vertex-digital/contracts';
import {
  type Database,
  depositFlags,
  depositReceipts,
  deposits,
  newId,
  queueDepositCard,
  recordAudit,
  type Transaction,
  usdtDeposits,
} from '@vertex-digital/db';
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AuthService, withinLimits } from '../auth/index.js';
import { FilesService, type ServedFile } from '../files/index.js';
import { type CurrentRate, RatesService } from '../rates/index.js';
import { SettingsService } from '../settings/index.js';
import {
  AlreadyCreated,
  checkCreation,
  checkNotStopped,
  customerDeposit,
  customerEntry,
  type DepositRow,
  insertDeposit,
  isOpen,
  isTrue,
  isUuid,
  limitsOf,
  lockCustomerCreations,
  lockDeposit,
  notFound,
  rateLimited,
  stateConflict,
} from './deposit-records.js';
import { type CurrentSettings, DepositSettingsService } from './deposit-settings.service.js';
import { customerUsdt, usdtRecords } from './usdt-records.js';

const HOUR_MS = 60 * 60 * 1000;

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
    private readonly switches: SettingsService,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/deposits/sham-cash/options` (rules SC1, SC3, SC13, FX8). */
  async options(customerId: string): Promise<ShamCashOptions> {
    const [settings, rate, switches, [pending]] = await Promise.all([
      this.settings.current(),
      this.rates.current(),
      this.switches.values(),
      this.db
        .select({ id: deposits.id })
        .from(deposits)
        .where(and(eq(deposits.customerId, customerId), eq(deposits.status, 'pending'))),
    ]);
    const option = (currency: Currency) => {
      const reason = unavailableReason(settings, rate, currency);
      return { available: reason === null, reason };
    };
    const currencies = { SYP: option('SYP'), USD: option('USD') };
    return {
      state: depositMethodState({
        stopped: switches.deposits_stopped,
        paused: switches.sham_cash_paused,
        ready: currencies.SYP.available || currencies.USD.available,
      }),
      currencies,
      account: settings && {
        name: settings.shamCashAccountName,
        number: settings.shamCashAccountNumber,
      },
      limits: settings && (await limitsOf(this.db, customerId, settings)),
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
        await lockCustomerCreations(tx, customerId);
        const [written] = await tx
          .select({ id: deposits.id })
          .from(deposits)
          .where(eq(deposits.idempotencyKey, idempotencyKey));
        if (written) throw new AlreadyCreated();
        await checkNotStopped(this.switches, tx, 'sham_cash');
        await checkCreation(tx, customerId);
        const limits = await limitsOf(tx, customerId, settings);
        const breach = depositLimitBreach(limits, declaredUsdUnits);
        if (breach) {
          throw new CodedException(422, 'DEPOSIT_LIMIT_EXCEEDED', 'Outside the limits', breach);
        }
        const created = await insertDeposit(tx, {
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
    return {
      items: await this.views(page.items.map(({ row }) => row)),
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
      // Each submission gets its own card in Telegram (S05 rule TC1).
      await queueDepositCard(tx, this.jobs, deposit.id);
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
      // A USDT deposit's check ends with it (S04); its amount stays reserved 7 days (rule U4).
      await tx
        .update(usdtDeposits)
        .set({ checkStatus: 'done', checkError: null })
        .where(eq(usdtDeposits.depositId, deposit.id));
      await recordAudit(tx, {
        ...customerEntry(customerId, deposit.id, meta),
        action: 'deposit.cancelled',
        details: { depositId: deposit.id },
      });
      // Only a deposit sent back for a clearer receipt has a card to close (S05 rule TC6).
      if (deposit.receiptRequestCount > 0) await queueDepositCard(tx, this.jobs, deposit.id);
      return updated;
    });
    return this.view(row);
  }

  /** The customer's view, with the current settings and ETA where its status shows them. */
  private async view(row: DepositRow, known?: CurrentSettings | null): Promise<Deposit> {
    const [view] = await this.views([row], known);
    if (!view) throw new Error(`Deposit ${row.id} has no view`);
    return view;
  }

  /** The customer's views of `rows`, with their USDT payments and checks (S04). */
  async views(rows: DepositRow[], known?: CurrentSettings | null): Promise<Deposit[]> {
    const settings = known === undefined ? await this.settings.current() : known;
    const submitted = rows.some((row) => row.status === 'submitted');
    const usdtIds = rows.filter((row) => row.method !== 'sham_cash').map((row) => row.id);
    const [eta, records, networks] = await Promise.all([
      submitted ? this.settings.eta(settings) : null,
      usdtRecords(this.db, usdtIds),
      usdtIds.length > 0 ? this.settings.usdtNetworks(settings) : [],
    ]);
    return rows.map((row) => {
      const record = records.get(row.id);
      const delayed = networks.find((network) => network.method === row.method)?.delayed ?? false;
      return customerDeposit(row, {
        settings,
        eta,
        usdt: record ? customerUsdt(record, delayed) : null,
      });
    });
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
    // A USDT deposit is paid on chain, never with a receipt (S04).
    if (deposit.method !== 'sham_cash') throw stateConflict(deposit.status);
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
      const limits = await limitsOf(tx, deposit.customerId, settings);
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

/** The status a refusal names: a `pending` deposit refused as not open is past its expiry. */
const openStatus = (deposit: DepositRow) =>
  deposit.status === 'pending' ? 'expired' : deposit.status;

function quoteOf(row: DepositRow) {
  if (!row.rateId || !row.rate) throw new Error(`Deposit ${row.id} has no quote`);
  return {
    rateId: row.rateId,
    rate: rateFromNumeric(row.rate),
    declaredUsdUnits: row.declaredUsdUnits,
  };
}
