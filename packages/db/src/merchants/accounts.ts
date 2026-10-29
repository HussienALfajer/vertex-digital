import {
  CUSTOMER_ORDERS_PER_TEN_MINUTES,
  customerStatus,
  effectivePriceListId,
  type Governorate,
  type MerchantDepositTier,
  priceKindOf,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { cancelAccountReservations, usableList } from '../customers/price-lists.js';
import { type AdminActor, CustomerError, type CustomerRow } from '../customers/state.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { customers, merchantLevels, merchantProfiles, merchantSettings } from '../schema/index.js';
import { endTierGrant } from './grants.js';
import { queueMerchantLevel } from './levels.js';
import { levelTier, merchantPrivileges, recordTierChange } from './tiers.js';

/*
 * Merchant accounts (S20 MA5–MA7, MD1): the grant (an approval or the admin's direct grant) and
 * the revocation change the account's type and list with the customer locked `FOR NO KEY UPDATE`
 * by the caller (purchases read it `FOR SHARE`, AT3), cancel its reservations when the list it
 * pays changes, and write the profile, the audit entry and the customer's notification.
 */

export type MerchantSettingsRow = typeof merchantSettings.$inferSelect;

/** The merchant settings in force: the newest version (seeded by migration 0081). */
export async function currentMerchantSettings(db: Executor): Promise<MerchantSettingsRow> {
  const [row] = await db
    .select()
    .from(merchantSettings)
    .orderBy(desc(merchantSettings.createdAt), desc(merchantSettings.id))
    .limit(1);
  if (!row) throw new Error('The merchant settings are not seeded');
  return row;
}

/**
 * MD1, MD3, S23 TS3: the deposit limits of a merchant's deposits, their effective tier's; null for
 * a customer.
 */
export async function merchantDepositTier(
  db: Executor,
  customerId: string,
): Promise<MerchantDepositTier | null> {
  const privileges = await merchantPrivileges(db, customerId);
  if (privileges === null) return null;
  return {
    perDepositUsdUnits: privileges.settings.perDepositUsdUnits,
    dailyDepositUsdUnits: privileges.settings.dailyDepositUsdUnits,
  };
}

/** PO5: orders and checkouts the account may place per 10 minutes, and whether it is a merchant's. */
export async function orderRate(
  db: Executor,
  customerId: string,
): Promise<{ merchant: boolean; perTenMinutes: number }> {
  const [customer] = await db
    .select({ accountType: customers.accountType })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (customer?.accountType !== 'merchant') {
    return { merchant: false, perTenMinutes: CUSTOMER_ORDERS_PER_TEN_MINUTES };
  }
  return {
    merchant: true,
    perTenMinutes: (await currentMerchantSettings(db)).ordersPerTenMinutes,
  };
}

export interface GrantInput {
  tradeName: string;
  governorate: Governorate;
  city: string;
  /** The approved application; null for a direct grant (MA6). */
  applicationId: string | null;
  /** The application's terms version; null for a direct grant until accepted (MT2). */
  termsVersionId: string | null;
  /** The chosen list; null or wholesale is the merchant default. */
  priceListId: string | null;
  /** A direct grant's reason (MA6); an approval's is the application. */
  reason: string | null;
  actor: AdminActor;
}

/**
 * MA5, MA6: makes the locked customer a merchant. Refused for a frozen or archived customer
 * (`CUSTOMER_STATE_INVALID`, edge case 10) and a merchant (`ALREADY_MERCHANT`); the list must be
 * usable. Returns the effective list and the reservations cancelled.
 */
export async function grantMerchant(
  tx: Transaction,
  context: { jobs: JobSender },
  customer: CustomerRow,
  input: GrantInput,
): Promise<{ effectiveListId: string; cancelledOrderIds: string[] }> {
  const status = customerStatus(customer);
  if (status !== 'active') {
    throw new CustomerError('CUSTOMER_STATE_INVALID', 'The customer is not active', { status });
  }
  if (customer.accountType === 'merchant') {
    throw new CustomerError('ALREADY_MERCHANT', 'The customer is a merchant already');
  }
  const priceListId =
    input.priceListId === ROOT_PRICE_LIST_IDS.wholesale ? null : input.priceListId;
  const after = { accountType: 'merchant' as const, priceListId };
  const effectiveListId = effectivePriceListId(after);
  const list = await usableList(tx, effectiveListId);
  await tx.update(customers).set(after).where(eq(customers.id, customer.id));
  const now = new Date();
  const profile = {
    tradeName: input.tradeName,
    governorate: input.governorate,
    city: input.city,
    applicationId: input.applicationId,
    termsVersionId: input.termsVersionId,
    grantedAt: now,
    revokedAt: null,
  };
  await tx
    .insert(merchantProfiles)
    .values({ customerId: customer.id, ...profile })
    .onConflictDoUpdate({ target: merchantProfiles.customerId, set: profile });
  // AT3, decision 11: a change of account type cancels the reservations, whatever the list.
  const cancelledOrderIds = await cancelAccountReservations(tx, context, customer.id);
  await recordAudit(tx, {
    action: 'customer.merchant_granted',
    actorKind: 'admin',
    actorId: input.actor.adminId,
    channel: 'admin',
    entityType: 'customer',
    entityId: customer.id,
    reason: input.reason,
    ipAddress: input.actor.ipAddress,
    userAgent: input.actor.userAgent,
    details: {
      applicationId: input.applicationId,
      tradeName: input.tradeName,
      priceListId,
      cancelledOrderIds,
    },
  });
  await notifyCustomer(tx, context.jobs, {
    customerId: customer.id,
    event: 'merchant_approved',
    params: { priceKind: priceKindOf(list.kind) },
  });
  // S21 LV7: a grant (a re-grant too) recomputes the volume level.
  await queueMerchantLevel(tx, context.jobs, customer.id);
  return { effectiveListId, cancelledOrderIds };
}

/**
 * MA7: returns the locked merchant to a customer on retail (`NOT_MERCHANT` otherwise); a frozen
 * or archived account may be revoked (edge case 8). The balance, orders and history stay.
 */
export async function revokeMerchant(
  tx: Transaction,
  context: { jobs: JobSender },
  customer: CustomerRow,
  input: { reason: string; actor: AdminActor },
): Promise<{ cancelledOrderIds: string[] }> {
  if (customer.accountType !== 'merchant') {
    throw new CustomerError('NOT_MERCHANT', 'The customer is not a merchant');
  }
  await tx
    .update(customers)
    .set({ accountType: 'customer', priceListId: null })
    .where(eq(customers.id, customer.id));
  const [profile] = await tx
    .select({ tier: merchantLevels.tier })
    .from(merchantProfiles)
    .leftJoin(merchantLevels, eq(merchantLevels.id, merchantProfiles.levelId))
    .where(eq(merchantProfiles.customerId, customer.id));
  await tx
    .update(merchantProfiles)
    // S21 LV7, S23 TR9: a revocation clears the levels; a new grant recomputes them.
    .set({
      revokedAt: sql`now()`,
      levelId: null,
      earnedLevelId: null,
      levelSource: null,
      levelChangedAt: sql`now()`,
    })
    .where(eq(merchantProfiles.customerId, customer.id));
  // TR9: an open grant ends with the revocation, and a tier above Bronze is left.
  await endTierGrant(tx, { ...context, now: new Date() }, customer.id, 'merchant_revoked', {
    kind: 'admin',
    actor: input.actor,
    reason: input.reason,
  });
  const tierBefore = levelTier(profile);
  if (tierBefore !== 'bronze') {
    await recordTierChange(tx, {
      customerId: customer.id,
      from: tierBefore,
      to: 'bronze',
      source: 'revoked',
    });
  }
  // AT3, decision 11: a revocation cancels the reservations, whatever the list.
  const cancelledOrderIds = await cancelAccountReservations(tx, context, customer.id);
  await recordAudit(tx, {
    action: 'customer.merchant_revoked',
    actorKind: 'admin',
    actorId: input.actor.adminId,
    channel: 'admin',
    entityType: 'customer',
    entityId: customer.id,
    reason: input.reason,
    ipAddress: input.actor.ipAddress,
    userAgent: input.actor.userAgent,
    details: { priceListIdBefore: customer.priceListId, cancelledOrderIds },
  });
  await notifyCustomer(tx, context.jobs, {
    customerId: customer.id,
    event: 'merchant_revoked',
    params: {},
  });
  return { cancelledOrderIds };
}
