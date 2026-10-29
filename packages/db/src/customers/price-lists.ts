import {
  type AccountType,
  accountPriceKind,
  customerStatus,
  effectivePriceListId,
  type PriceKind,
  type PriceListKind,
} from '@vertex-digital/contracts';
import { and, asc, count, eq, isNotNull, isNull } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { levelListId } from '../merchants/levels.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { cancelReservation } from '../orders/reservations.js';
import { listIsPriced, listPricingFacts } from '../pricing/reprice.js';
import { customers, orders, priceLists } from '../schema/index.js';
import { type AdminActor, CustomerError, lockCustomer } from './state.js';

/*
 * An account's price list (S20 AT1–AT4): the list it pays, read for the store's private prices,
 * the profile and the lists page, and the admin's assignment, which locks the customer first
 * (purchases read it `FOR SHARE`, AT3) and the list `FOR SHARE` (an archive takes it
 * `FOR NO KEY UPDATE`, LS5).
 */

/** The list an account pays, with what the customer may learn of it (AT4: the kind only). */
export interface AccountPriceList {
  accountType: AccountType;
  /** The assigned list; null is the type's default. */
  assignedListId: string | null;
  effectiveList: { id: string; kind: PriceListKind; name: string };
  priceKind: PriceKind;
}

/** The account's effective list (AT1), or null for an unknown customer. */
export async function accountPriceList(
  db: Executor,
  customerId: string,
): Promise<AccountPriceList | null> {
  const [customer] = await db
    .select({ accountType: customers.accountType, priceListId: customers.priceListId })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;
  // S21 LV5: a merchant's level picks the list below an assigned one.
  const levelList = customer.accountType === 'merchant' ? await levelListId(db, customerId) : null;
  const id = effectivePriceListId({ ...customer, levelListId: levelList });
  const [list] = await db
    .select({ id: priceLists.id, kind: priceLists.kind, name: priceLists.name })
    .from(priceLists)
    .where(eq(priceLists.id, id));
  if (!list) throw new Error(`Price list ${id} does not exist`);
  return {
    accountType: customer.accountType,
    assignedListId: customer.priceListId,
    effectiveList: list,
    // S23 PX6: a tier list reads as wholesale.
    priceKind: accountPriceKind(list.kind, customer.priceListId === null && levelList !== null),
  };
}

/** Accounts assigned to each list (AT2), keyed by list id; a type's default is not counted. */
export async function assignedAccountCounts(db: Executor): Promise<Map<string, number>> {
  const rows = await db
    .select({ priceListId: customers.priceListId, count: count() })
    .from(customers)
    .where(isNotNull(customers.priceListId))
    .groupBy(customers.priceListId);
  return new Map(rows.map((row) => [row.priceListId as string, row.count]));
}

/** The first accounts assigned to a list, by name. */
export function assignedAccounts(db: Executor, priceListId: string, limit: number) {
  return db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      accountType: customers.accountType,
    })
    .from(customers)
    .where(eq(customers.priceListId, priceListId))
    .orderBy(asc(customers.name), asc(customers.id))
    .limit(limit);
}

/**
 * S20 AT2, AT3: assigns an unarchived, priced list to an account, or returns it to its type's
 * default (`null`). An archived account is refused (`CUSTOMER_STATE_INVALID`); a frozen one may be
 * assigned. When the effective list changes, the account's reservations are cancelled
 * (`price_list_changed`, S09's email) and the customer told (`price_list_changed`, center only).
 * The audit entry is written either way.
 */
export async function setCustomerPriceList(
  tx: Transaction,
  context: { jobs: JobSender },
  input: { customerId: string; priceListId: string | null; reason: string; actor: AdminActor },
): Promise<{ cancelledOrderIds: string[] }> {
  const customer = await lockCustomer(tx, input.customerId);
  const status = customerStatus(customer);
  if (status === 'archived') {
    throw new CustomerError('CUSTOMER_STATE_INVALID', 'The customer is archived', { status });
  }
  // S21 LV5: the level's list stands under the assignment, on both sides.
  const level = customer.accountType === 'merchant' ? await levelListId(tx, customer.id) : null;
  const afterListId = effectivePriceListId({
    ...customer,
    priceListId: input.priceListId,
    levelListId: level,
  });
  const list = await usableList(tx, afterListId);
  const beforeListId = effectivePriceListId({ ...customer, levelListId: level });
  await tx
    .update(customers)
    .set({ priceListId: input.priceListId })
    .where(eq(customers.id, customer.id));
  let cancelledOrderIds: string[] = [];
  if (afterListId !== beforeListId) {
    cancelledOrderIds = await cancelAccountReservations(tx, context, customer.id);
    await notifyCustomer(
      tx,
      context.jobs,
      {
        customerId: customer.id,
        event: 'price_list_changed',
        // S23 PX6: back on the tier's list, the account reads wholesale.
        params: {
          priceKind: accountPriceKind(list.kind, input.priceListId === null && level !== null),
        },
      },
      { email: false },
    );
  }
  await recordAudit(tx, {
    action: 'customer.price_list_changed',
    actorKind: 'admin',
    actorId: input.actor.adminId,
    channel: 'admin',
    entityType: 'customer',
    entityId: customer.id,
    reason: input.reason,
    ipAddress: input.actor.ipAddress,
    userAgent: input.actor.userAgent,
    details: {
      before: { priceListId: customer.priceListId, effectiveListId: beforeListId },
      after: { priceListId: input.priceListId, effectiveListId: afterListId },
      cancelledOrderIds,
    },
  });
  return { cancelledOrderIds };
}

/**
 * AT2: the list an account is moved to, `FOR SHARE` against an archive (LS5): unarchived
 * (`PRICE_LIST_ARCHIVED`) and priced (`PRICE_LIST_NOT_READY`, RP6).
 */
export async function usableList(tx: Transaction, priceListId: string) {
  const [list] = await tx
    .select()
    .from(priceLists)
    .where(eq(priceLists.id, priceListId))
    .for('share');
  if (!list) throw new CustomerError('NOT_FOUND', 'No such price list');
  if (list.archivedAt !== null) {
    throw new CustomerError('PRICE_LIST_ARCHIVED', 'The price list is archived');
  }
  const facts = await listPricingFacts(tx, []);
  const chain = facts.lists.find((candidate) => candidate.id === list.id)?.chain ?? [list.id];
  if (!listIsPriced(facts, chain)) {
    throw new CustomerError('PRICE_LIST_NOT_READY', 'The price list is not priced yet');
  }
  return list;
}

/**
 * AT3 (decision 11): cancels the account's reservations with `price_list_changed` (S09's email),
 * the orders `FOR UPDATE` in id order; the customer is locked by the caller.
 */
export async function cancelAccountReservations(
  tx: Transaction,
  context: { jobs: JobSender },
  customerId: string,
): Promise<string[]> {
  const reserved = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.status, 'awaiting_balance')))
    .orderBy(asc(orders.id))
    .for('update');
  const cancelledOrderIds: string[] = [];
  for (const order of reserved) {
    const cancelled = await cancelReservation(tx, context, order, 'price_list_changed', {
      kind: 'system',
    });
    if (cancelled) cancelledOrderIds.push(cancelled.id);
  }
  return cancelledOrderIds;
}

/** Unarchived accounts on a list's id, for LS5's refusal (assigned, never a type's default). */
export async function accountsOnList(db: Executor, priceListId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(customers)
    .where(and(eq(customers.priceListId, priceListId), isNull(customers.archivedAt)));
  return row?.count ?? 0;
}

/**
 * LS5 for archived accounts: archiving a list returns the archived accounts still assigned to it
 * to their type's default (they hold no reservation, AR1), each with its audit entry, so no
 * account is ever left on an archived list.
 */
export async function releaseArchivedAccounts(
  tx: Transaction,
  input: { priceListId: string; reason: string; actor: AdminActor },
): Promise<number> {
  const rows = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.priceListId, input.priceListId), isNotNull(customers.archivedAt)))
    .orderBy(asc(customers.id))
    .for('no key update');
  for (const customer of rows) {
    await tx.update(customers).set({ priceListId: null }).where(eq(customers.id, customer.id));
    await recordAudit(tx, {
      action: 'customer.price_list_changed',
      actorKind: 'admin',
      actorId: input.actor.adminId,
      channel: 'admin',
      entityType: 'customer',
      entityId: customer.id,
      reason: input.reason,
      ipAddress: input.actor.ipAddress,
      userAgent: input.actor.userAgent,
      details: {
        before: { priceListId: customer.priceListId, effectiveListId: input.priceListId },
        after: {
          priceListId: null,
          effectiveListId: effectivePriceListId({
            ...customer,
            priceListId: null,
            levelListId:
              customer.accountType === 'merchant' ? await levelListId(tx, customer.id) : null,
          }),
        },
        cancelledOrderIds: [],
      },
    });
  }
  return rows.length;
}

/**
 * LS5's first lock: every account assigned to the list, archived or not, `FOR NO KEY UPDATE` in
 * id order, before the list itself (the order assignments take). An unarchive or an assignment
 * running alongside then finishes first, and the archive counts what it left.
 */
export async function lockAccountsOnList(tx: Transaction, priceListId: string): Promise<void> {
  await tx
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.priceListId, priceListId))
    .orderBy(asc(customers.id))
    .for('no key update');
}
