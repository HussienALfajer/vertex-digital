import {
  type AccountType,
  type CustomerLimitOverrides,
  effectivePriceListId,
  NO_LIMIT_OVERRIDES,
  type PurchaseCapBreach,
  purchaseCapBreach,
  type TierQuantities,
} from '@vertex-digital/contracts';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { levelListId } from '../merchants/levels.js';
import { merchantPrivileges, tierQuantities } from '../merchants/tiers.js';
import { OrderError } from '../orders/errors.js';
import { customerLimits, customers, merchantProfiles, orders } from '../schema/index.js';

/*
 * The customer's side of every purchase and deposit (S12 CF2, LM4): the customer row read
 * `FOR SHARE` before any write, so a freeze or an archive (`FOR UPDATE`) and a purchase never
 * interleave; a frozen customer is refused with `ACCOUNT_FROZEN`, and a purchase beyond the daily
 * cap with `PURCHASE_LIMIT_EXCEEDED`. The refusals are `OrderError`s, which carry the contract
 * code (the deposit routes answer them the same way).
 */

export interface PurchasingCustomer {
  id: string;
  isTest: boolean;
  /** S20 AT1, S21 LV5: the list the customer pays (`effectivePriceListId`), read under the lock (AT3). */
  priceListId: string;
  /** S21: a merchant's purchase writes a sale row and may send the low-balance alert. */
  accountType: AccountType;
  /** The daily purchase cap (LM4), or null for none. */
  capUnits: number | null;
  /** S20 MT2: a merchant who has not accepted the merchant terms yet (a direct grant). */
  merchantTermsRequired: boolean;
  /** S23 TS5: a merchant's tier quantities, read under the lock; null for a customer. */
  tierQuantities: TierQuantities | null;
  /** S23 OP5: a merchant whose tier sees and buys early-access games and packs. */
  earlyAccess: boolean;
}

/** The customer's overrides; a missing row is all null (S12 data). */
export async function customerLimitOverrides(
  db: Database | Transaction,
  customerId: string,
): Promise<CustomerLimitOverrides> {
  const [row] = await db
    .select({
      perDepositUsdUnits: customerLimits.perDepositUsdUnits,
      dailyDepositUsdUnits: customerLimits.dailyDepositUsdUnits,
      dailyPurchaseUsdUnits: customerLimits.dailyPurchaseUsdUnits,
    })
    .from(customerLimits)
    .where(eq(customerLimits.customerId, customerId));
  return row ?? NO_LIMIT_OVERRIDES;
}

/**
 * Rule CF2: reads the customer `FOR SHARE` and refuses a frozen one, and an archived one (AR1: a
 * request that waited behind an archive writes nothing). Every creation path calls it in its own
 * transaction before writing anything.
 */
export async function lockActiveCustomer(
  tx: Transaction,
  customerId: string,
): Promise<PurchasingCustomer> {
  const [customer] = await tx
    .select({
      isTest: customers.isTest,
      frozenAt: customers.frozenAt,
      archivedAt: customers.archivedAt,
      accountType: customers.accountType,
      priceListId: customers.priceListId,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .for('share');
  if (!customer) throw new Error(`Customer ${customerId} does not exist`);
  if (customer.frozenAt !== null || customer.archivedAt !== null) {
    throw new OrderError('ACCOUNT_FROZEN', 'The account is frozen');
  }
  const overrides = await customerLimitOverrides(tx, customerId);
  let merchantTermsRequired = false;
  let merchantLevelListId: string | null = null;
  let quantities: TierQuantities | null = null;
  let earlyAccess = false;
  if (customer.accountType === 'merchant') {
    merchantLevelListId = await levelListId(tx, customerId);
    const privileges = await merchantPrivileges(tx, customerId);
    quantities = privileges && tierQuantities(privileges.settings);
    earlyAccess = privileges?.settings.earlyAccess ?? false;
    const [profile] = await tx
      .select({ termsVersionId: merchantProfiles.termsVersionId })
      .from(merchantProfiles)
      .where(eq(merchantProfiles.customerId, customerId));
    // A direct grant writes the profile without a version (MT2); every grant writes a profile.
    merchantTermsRequired = profile !== undefined && profile.termsVersionId === null;
  }
  return {
    id: customerId,
    isTest: customer.isTest,
    priceListId: effectivePriceListId({ ...customer, levelListId: merchantLevelListId }),
    accountType: customer.accountType,
    capUnits: overrides.dailyPurchaseUsdUnits,
    merchantTermsRequired,
    tierQuantities: quantities,
    earlyAccess,
  };
}

/** S20 MT2: purchases, checkouts and reservations wait for a merchant's terms acceptance. */
export function requireMerchantTerms(customer: PurchasingCustomer): void {
  if (customer.merchantTermsRequired) {
    throw new OrderError('MERCHANT_TERMS_REQUIRED', 'The merchant terms are not accepted yet');
  }
}

/**
 * Rule LM4: what the customer bought in the last 24 hours, net of refunds: every order paid since
 * from their wallet (S16: an `on_behalf` admin order counts, a gift or compensation does not), its
 * total less what was refunded.
 */
export async function purchasedLastDay(
  db: Database | Transaction,
  customerId: string,
): Promise<number> {
  const [row] = await db
    .select({
      used: sql<string>`coalesce(sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(orders.payer, 'customer'),
        gt(orders.paidAt, sql`now() - interval '24 hours'`),
      ),
    );
  return Number(row?.used ?? 0);
}

/** Rule LM4: the breach of a purchase of `units` today, or null (no cap, or it fits). */
export async function purchaseCapCheck(
  tx: Transaction,
  customer: PurchasingCustomer,
  units: number,
): Promise<PurchaseCapBreach | null> {
  if (customer.capUnits === null) return null;
  return purchaseCapBreach(customer.capUnits, await purchasedLastDay(tx, customer.id), units);
}

/** Rule LM4: refuses a purchase of `units` beyond the cap with what remains. */
export async function checkPurchaseCap(
  tx: Transaction,
  customer: PurchasingCustomer,
  units: number,
): Promise<void> {
  const breach = await purchaseCapCheck(tx, customer, units);
  if (breach) {
    throw new OrderError('PURCHASE_LIMIT_EXCEEDED', 'Beyond the daily purchase cap', breach);
  }
}

/** Rule LM4: a reservation whose total alone is above the cap is refused at creation. */
export function checkReservationCap(customer: PurchasingCustomer, units: number): void {
  const breach = purchaseCapBreach(customer.capUnits, 0, units);
  if (breach) {
    throw new OrderError('PURCHASE_LIMIT_EXCEEDED', 'Beyond the daily purchase cap', breach);
  }
}
