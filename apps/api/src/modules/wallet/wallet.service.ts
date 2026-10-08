import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminWallet,
  type AdminWalletEntryPage,
  type CursorQuery,
  type LedgerSummary,
  type Wallet,
  type WalletEntryPage,
  type WalletSearchPage,
  walletSypValue,
} from '@vertex-digital/contracts';
import {
  accountBalance,
  customerWalletBalances,
  type Database,
  findCustomerWallet,
  ledgerSummary,
  walletAdjustments,
  walletTimeline,
} from '@vertex-digital/db';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { AdminAuthService } from '../admin/index.js';
import { AuthService } from '../auth/index.js';
import { RatesService } from '../rates/index.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** A timeline cursor (rule W7): the write position of the page's last entry, opaque to clients. */
const encodeTimelineCursor = (position: number) =>
  Buffer.from(String(position)).toString('base64url');

function decodeTimelineCursor(cursor: string): { position: number } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const position = Number(text);
  if (!/^\d{1,15}$/.test(text) || !Number.isSafeInteger(position)) {
    throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid cursor', [
      { path: ['cursor'], message: 'Invalid cursor' },
    ]);
  }
  return { position };
}

/**
 * Wallet reads (S02 rules W1–W10, L1): the customer's own balance and timeline, the admin's
 * search, wallet page and ledger summary. Nothing here writes; reading never creates a wallet.
 */
@Injectable()
export class WalletService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly customers: AuthService,
    private readonly admins: AdminAuthService,
    private readonly rates: RatesService,
  ) {}

  /** Rule W9, S03 rules FX8 and FX9: the SYP value at the rate in force, null before any rate. */
  async wallet(customerId: string): Promise<Wallet> {
    const [accountId, rate] = await Promise.all([
      findCustomerWallet(this.db, customerId),
      this.rates.current(),
    ]);
    const balanceUnits = accountId ? await accountBalance(this.db, accountId) : 0;
    return {
      balanceUnits,
      syp: rate && {
        valueUnits: walletSypValue(balanceUnits, rate.sypPerUsd, rate.displayStepSypUnits),
        rate: rate.sypPerUsd,
      },
    };
  }

  /** The customer's own timeline (rules W3–W6): no reason, admin, journal or account. */
  async entries(customerId: string, query: CursorQuery): Promise<WalletEntryPage> {
    const page = await this.timeline(customerId, query);
    return {
      items: page.entries.map((entry) => ({
        occurredAt: entry.occurredAt.toISOString(),
        kind: entry.kind,
        amountUnits: entry.amountUnits,
        balanceAfterUnits: entry.balanceAfterUnits,
        adjustment: entry.adjustment && {
          category: entry.adjustment.category,
          customerNote: entry.adjustment.customerNote,
          reversal: entry.adjustment.reversesAdjustmentId !== null,
        },
        deposit: entry.deposit && {
          method: entry.deposit.method,
          referenceCode: entry.deposit.referenceCode,
          syp: entry.deposit.syp,
        },
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** The customer's balance (S03: the deposit review's customer panel). */
  async balanceOf(customerId: string): Promise<number> {
    const accountId = await findCustomerWallet(this.db, customerId);
    return accountId ? accountBalance(this.db, accountId) : 0;
  }

  async search(q: string, query: CursorQuery): Promise<WalletSearchPage> {
    const page = await this.customers.searchCustomers(q, query);
    const balances = await customerWalletBalances(
      this.db,
      page.items.map((customer) => customer.id),
    );
    return {
      items: page.items.map((customer) => ({
        ...customer,
        balanceUnits: balances.get(customer.id) ?? 0,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async adminWallet(customerId: string): Promise<AdminWallet> {
    const customer = isUuid(customerId) ? await this.customers.walletCustomer(customerId) : null;
    if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
    const [wallet, [adjustments]] = await Promise.all([
      this.wallet(customerId),
      this.db
        .select({ count: count() })
        .from(walletAdjustments)
        .where(eq(walletAdjustments.customerId, customerId)),
    ]);
    return { ...wallet, customer, adjustmentCount: adjustments?.count ?? 0 };
  }

  /** The admin's view of a timeline, with the adjustments' internal details. */
  async adminEntries(customerId: string, query: CursorQuery): Promise<AdminWalletEntryPage> {
    const customer = isUuid(customerId) ? await this.customers.walletCustomer(customerId) : null;
    if (!customer) throw new CodedException(404, 'NOT_FOUND', 'No such customer');
    const page = await this.timeline(customerId, query);
    const adminNames = await this.admins.namesOf([
      ...new Set(page.entries.flatMap((entry) => entry.adjustment?.adminId ?? [])),
    ]);
    return {
      items: page.entries.map((entry) => ({
        journalId: entry.journalId,
        occurredAt: entry.occurredAt.toISOString(),
        kind: entry.kind,
        amountUnits: entry.amountUnits,
        balanceAfterUnits: entry.balanceAfterUnits,
        adjustment: entry.adjustment && {
          id: entry.adjustment.id,
          direction: entry.adjustment.direction,
          category: entry.adjustment.category,
          customerNote: entry.adjustment.customerNote,
          reversal: entry.adjustment.reversesAdjustmentId !== null,
          reason: entry.adjustment.reason,
          adminName: adminNames.get(entry.adjustment.adminId) ?? null,
          depositMethod: entry.adjustment.depositMethod,
          externalReference: entry.adjustment.externalReference,
          reversesAdjustmentId: entry.adjustment.reversesAdjustmentId,
          reversedByAdjustmentId: entry.adjustment.reversedByAdjustmentId,
        },
        deposit: entry.deposit,
      })),
      nextCursor: page.nextCursor,
    };
  }

  summary(): Promise<LedgerSummary> {
    return ledgerSummary(this.db);
  }

  private async timeline(customerId: string, query: CursorQuery) {
    const after = query.cursor ? decodeTimelineCursor(query.cursor) : undefined;
    const accountId = await findCustomerWallet(this.db, customerId);
    if (!accountId) return { entries: [], nextCursor: null };
    const { entries, more } = await walletTimeline(this.db, accountId, {
      after,
      limit: query.limit,
    });
    const last = entries.at(-1);
    const nextCursor = more && last ? encodeTimelineCursor(last.position.position) : null;
    return { entries, nextCursor };
  }
}
