import { CURRENCY_SCALE } from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../client.js';
import { lockCustomer } from '../customers/state.js';
import { newId } from '../id.js';
import { accountBalance } from '../ledger/balance.js';
import { postJournal } from '../ledger/post-journal.js';
import {
  ensureCustomerWallet,
  ensureSystemAccount,
  findShopCustomerWallet,
  ledgerSummary,
  lockShopCustomerWallet,
} from '../ledger/wallet.js';
import { revokeMerchant } from '../merchants/accounts.js';
import { internalChecks } from '../reconciliation/internal.js';
import {
  auditEntries,
  customers,
  emailOutbox,
  merchantShopRates,
  merchantShops,
  shopCustomers,
  shopReturnRequests,
  shopTransfers,
  telegramMessages,
} from '../schema/index.js';
import { closeShop, settleShopCustomer } from './close.js';
import { endShopReturn, expireShopReturns, requestShopReturn } from './returns.js';
import type { ShopActor, ShopError } from './state.js';
import { transferToShopCustomer } from './transfers.js';

/*
 * S26 PR 1 write paths and the guards of migration 0113, on PostgreSQL as the app role (the owner
 * only to prove a guard refuses it too): transfers (WL1–WL4), returns (WL5, WL6), settlement
 * (WL9), the close on revocation (SH7) and the reconciliation of their journals (C9).
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;
const jobs = { send: async () => newId() };
const USD = CURRENCY_SCALE.USD;
const merchantActor = (id: string): ShopActor => ({ kind: 'customer', id, channel: 'store' });
const adminActor = { kind: 'admin', id: newId(), channel: 'admin' } as const;

afterAll(async () => {
  await Promise.all([connection.close(), owner.close()]);
});

class Rollback extends Error {}

async function rolledBack<T>(work: (tx: Transaction) => Promise<T>, target: Database = db) {
  await target
    .transaction(async (tx) => {
      await work(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

/** The error a step throws, under a savepoint so the transaction goes on. */
async function refusal(tx: Transaction, step: (tx: Transaction) => Promise<unknown>) {
  try {
    await tx.transaction(async (inner) => {
      await step(inner);
    });
  } catch (error) {
    return error as ShopError & { code: string; details?: Record<string, unknown> };
  }
  throw new Error('Expected a refusal');
}

/** A refused query's own message: drizzle wraps it in "Failed query" with the cause. */
const text = (error: unknown) =>
  String((error as { cause?: { message?: string } }).cause?.message ?? error);

async function merchant(tx: Database | Transaction, fundsUsd = 100) {
  const id = newId();
  await tx.insert(customers).values({
    id,
    name: 'Merchant',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000001',
    emailVerified: true,
    accountType: 'merchant',
  });
  if (fundsUsd > 0) {
    await tx.transaction(async (inner) => {
      await postJournal(inner, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(inner, id), amountUnits: fundsUsd * USD },
          {
            accountId: await ensureSystemAccount(inner, {
              code: 'adjustments:correction',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -fundsUsd * USD,
          },
        ],
      });
    });
  }
  return id;
}

async function shop(
  tx: Database | Transaction,
  merchantId: string,
  values: Partial<typeof merchantShops.$inferInsert> = {},
) {
  const id = newId();
  await tx.insert(merchantShops).values({
    id,
    merchantId,
    slug: `s${id.slice(-12)}`,
    displayName: 'متجر النور',
    brandColor: '#1f7a6c',
  });
  await tx
    .update(merchantShops)
    .set({ status: 'active', decidedAt: sql`now()`, ...values })
    .where(eq(merchantShops.id, id));
  return id;
}

async function shopCustomer(
  tx: Database | Transaction,
  shopId: string,
  values: Partial<typeof shopCustomers.$inferInsert> = {},
) {
  const id = newId();
  await tx.insert(shopCustomers).values({
    id,
    shopId,
    name: 'سامي',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000002',
    emailVerified: true,
    createdBy: 'merchant',
    ...values,
  });
  return id;
}

async function setting(tx: Transaction) {
  const merchantId = await merchant(tx);
  const shopId = await shop(tx, merchantId);
  const customerId = await shopCustomer(tx, shopId);
  return { merchantId, shopId, customerId };
}

const transfer = (
  tx: Transaction,
  ids: { merchantId: string; shopId: string; customerId: string },
  amountUsd: number,
  extra: Partial<Parameters<typeof transferToShopCustomer>[2]> = {},
) =>
  transferToShopCustomer(tx, jobs, {
    shopId: ids.shopId,
    merchantId: ids.merchantId,
    shopCustomerId: ids.customerId,
    currency: 'usd',
    amountUnits: amountUsd * USD,
    expectedUsdUnits: amountUsd * USD,
    idempotencyKey: newId(),
    actor: merchantActor(ids.merchantId),
    ...extra,
  });

async function shopBalance(tx: Database | Transaction, customerId: string) {
  const wallet = await findShopCustomerWallet(tx, customerId);
  return wallet === null ? 0 : accountBalance(tx, wallet);
}

async function merchantBalance(tx: Transaction, merchantId: string) {
  return accountBalance(tx, await ensureCustomerWallet(tx, merchantId));
}

describe('transfers (WL1–WL4)', () => {
  it('moves USD from the merchant to the shop customer, with its row, audit and emails', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      const outcome = await transfer(tx, ids, 25);
      expect(outcome).toMatchObject({
        customerBalanceUsdUnits: 25 * USD,
        merchantBalanceUsdUnits: 75 * USD,
        transferredTodayUsdUnits: 25 * USD,
        replayed: false,
      });
      expect(await shopBalance(tx, ids.customerId)).toBe(25 * USD);
      expect(await merchantBalance(tx, ids.merchantId)).toBe(75 * USD);
      expect(outcome.transfer).toMatchObject({ cause: 'transfer', direction: 'to_customer' });
      const audit = await tx
        .select({ action: auditEntries.action })
        .from(auditEntries)
        .where(eq(auditEntries.entityId, ids.shopId));
      expect(audit).toEqual([{ action: 'shop.transfer' }]);
      const emails = await tx
        .select({ template: emailOutbox.template })
        .from(emailOutbox)
        .where(sql`${emailOutbox.params}->>'amountUsdUnits' = ${String(25 * USD)}
          and ${emailOutbox.createdAt} = now()`);
      expect(emails.map((row) => row.template).sort()).toEqual([
        'customer_merchant_shop_transfer',
        'shop_customer_transfer_received',
      ]);
    });
  });

  it('converts SYP at the own rate, rounded down to cents, and refuses another expected USD', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await tx
        .update(merchantShops)
        .set({ rateMode: 'own' })
        .where(eq(merchantShops.id, ids.shopId));
      await tx
        .insert(merchantShopRates)
        .values({ shopId: ids.shopId, rateSypPerUsd: '11000', confirmedFar: false });
      const changed = await refusal(tx, (inner) =>
        transfer(inner, ids, 0, {
          currency: 'syp',
          amountUnits: 10_000 * CURRENCY_SCALE.SYP,
          expectedUsdUnits: 910_000,
        }),
      );
      expect(changed).toMatchObject({
        code: 'PRICE_CHANGED',
        details: { amountUsdUnits: 900_000 },
      });
      const outcome = await transfer(tx, ids, 0, {
        currency: 'syp',
        amountUnits: 10_000 * CURRENCY_SCALE.SYP,
        expectedUsdUnits: 900_000,
      });
      expect(outcome.transfer).toMatchObject({
        amountUsdUnits: 900_000,
        enteredCurrency: 'syp',
        enteredAmountUnits: 10_000 * CURRENCY_SCALE.SYP,
        rateSypPerUsd: '11000.0000',
      });
    });
  });

  it('refuses by the caps, the balance, the states and another merchant (WL3, WL4)', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await tx
        .update(merchantShops)
        .set({ customerBalanceCapUsdUnits: 30 * USD, dailyTransferCapUsdUnits: 50 * USD })
        .where(eq(merchantShops.id, ids.shopId));
      await transfer(tx, ids, 25);
      expect(await refusal(tx, (inner) => transfer(inner, ids, 10))).toMatchObject({
        code: 'SHOP_BALANCE_CAP_EXCEEDED',
        details: { largestUsdUnits: 5 * USD },
      });
      const second = { ...ids, customerId: await shopCustomer(tx, ids.shopId) };
      await transfer(tx, second, 20);
      expect(await refusal(tx, (inner) => transfer(inner, second, 10))).toMatchObject({
        code: 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED',
        details: { remainingUsdUnits: 5 * USD },
      });
      const third = { ...ids, customerId: await shopCustomer(tx, ids.shopId) };
      await tx
        .update(merchantShops)
        .set({ dailyTransferCapUsdUnits: 1_000 * USD })
        .where(eq(merchantShops.id, ids.shopId));
      expect(await refusal(tx, (inner) => transfer(inner, third, 60))).toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });
      expect(await refusal(tx, (inner) => transfer(inner, third, 0.05))).toMatchObject({
        code: 'VALIDATION_FAILED',
      });

      const unverified = {
        ...ids,
        customerId: await shopCustomer(tx, ids.shopId, { emailVerified: false }),
      };
      expect(await refusal(tx, (inner) => transfer(inner, unverified, 1))).toMatchObject({
        code: 'CUSTOMER_STATE_INVALID',
      });
      const frozen = {
        ...ids,
        customerId: await shopCustomer(tx, ids.shopId, {
          frozenAt: new Date(),
          frozenReason: 'test',
        }),
      };
      expect(await refusal(tx, (inner) => transfer(inner, frozen, 1))).toMatchObject({
        code: 'ACCOUNT_FROZEN',
      });
      const stranger = { ...ids, merchantId: await merchant(tx) };
      expect(await refusal(tx, (inner) => transfer(inner, stranger, 1))).toMatchObject({
        code: 'NOT_FOUND',
      });
      const elsewhere = {
        ...ids,
        customerId: await shopCustomer(tx, await shop(tx, await merchant(tx, 0))),
      };
      expect(await refusal(tx, (inner) => transfer(inner, elsewhere, 1))).toMatchObject({
        code: 'NOT_FOUND',
      });
      await tx
        .update(merchantShops)
        .set({ status: 'suspended', suspendReason: 'review', suspendNote: 'test' })
        .where(eq(merchantShops.id, ids.shopId));
      expect(await refusal(tx, (inner) => transfer(inner, third, 1))).toMatchObject({
        code: 'SHOP_UNAVAILABLE',
      });
      await tx
        .update(merchantShops)
        .set({ status: 'active' })
        .where(eq(merchantShops.id, ids.shopId));
      await tx
        .update(customers)
        .set({ frozenAt: new Date() })
        .where(eq(customers.id, ids.merchantId));
      expect(await refusal(tx, (inner) => transfer(inner, third, 1))).toMatchObject({
        code: 'ACCOUNT_FROZEN',
      });
    });
  });

  it('replays a repeated key and refuses it for another transfer', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      const idempotencyKey = newId();
      const first = await transfer(tx, ids, 10, { idempotencyKey });
      const again = await transfer(tx, ids, 10, { idempotencyKey });
      expect(again).toMatchObject({ replayed: true, customerBalanceUsdUnits: 10 * USD });
      expect(again.transfer.id).toBe(first.transfer.id);
      expect(
        await refusal(tx, (inner) => transfer(inner, ids, 11, { idempotencyKey })),
      ).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    });
  });

  it('serializes parallel transfers on the merchant wallet: the day cap holds, one key posts once', async () => {
    const merchantId = await merchant(db);
    const shopId = await shop(db, merchantId, { dailyTransferCapUsdUnits: 15 * USD });
    const ids = { merchantId, shopId, customerId: await shopCustomer(db, shopId) };
    const other = { ...ids, customerId: await shopCustomer(db, shopId) };
    const run = (target: typeof ids, key = newId()) =>
      db.transaction((tx) => transfer(tx, target, 10, { idempotencyKey: key }));
    const results = await Promise.allSettled([run(ids), run(other)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED',
    });

    await db
      .update(merchantShops)
      .set({ dailyTransferCapUsdUnits: 1_000 * USD })
      .where(eq(merchantShops.id, shopId));
    const key = newId();
    const twice = await Promise.all([run(ids, key), run(ids, key)]);
    expect(twice.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
    const rows = await db.select().from(shopTransfers).where(eq(shopTransfers.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });
});

describe('return requests (WL5, WL6)', () => {
  it('moves the amount back on the customer confirm, once', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await transfer(tx, ids, 30);
      const { request } = await requestShopReturn(tx, jobs, {
        shopId: ids.shopId,
        merchantId: ids.merchantId,
        shopCustomerId: ids.customerId,
        amountUsdUnits: 20 * USD,
        idempotencyKey: newId(),
        actor: merchantActor(ids.merchantId),
      });
      expect(request.status).toBe('pending');
      expect(request.expiresAt.getTime() - request.createdAt.getTime()).toBe(24 * 3600 * 1000);
      const second = await refusal(tx, (inner) =>
        requestShopReturn(inner, jobs, {
          shopId: ids.shopId,
          merchantId: ids.merchantId,
          shopCustomerId: ids.customerId,
          amountUsdUnits: USD,
          idempotencyKey: newId(),
          actor: merchantActor(ids.merchantId),
        }),
      );
      expect(second).toMatchObject({ code: 'RETURN_REQUEST_PENDING' });
      const customerActor = {
        kind: 'shop_customer',
        id: ids.customerId,
        channel: 'store',
      } as const;
      const stranger = await refusal(tx, (inner) =>
        endShopReturn(
          inner,
          jobs,
          request.id,
          { action: 'confirm', shopCustomerId: newId(), idempotencyKey: newId() },
          customerActor,
        ),
      );
      expect(stranger).toMatchObject({ code: 'NOT_FOUND' });
      const key = newId();
      const end = {
        action: 'confirm',
        shopCustomerId: ids.customerId,
        idempotencyKey: key,
      } as const;
      const confirmed = await endShopReturn(tx, jobs, request.id, end, customerActor);
      expect(confirmed.request.status).toBe('confirmed');
      expect(await shopBalance(tx, ids.customerId)).toBe(10 * USD);
      expect(await merchantBalance(tx, ids.merchantId)).toBe(90 * USD);
      const again = await endShopReturn(tx, jobs, request.id, end, customerActor);
      expect(again).toMatchObject({ replayed: true, transferId: confirmed.transferId });
      expect(
        await refusal(tx, (inner) =>
          endShopReturn(
            inner,
            jobs,
            request.id,
            { ...end, idempotencyKey: newId() },
            customerActor,
          ),
        ),
      ).toMatchObject({ code: 'RETURN_REQUEST_STATE_INVALID' });
      const notified = await tx.execute(
        sql`select params->>'status' as status from customer_notifications
          where customer_id = ${ids.merchantId} and event = 'merchant_shop_return_ended'`,
      );
      expect(notified.rows).toEqual([{ status: 'confirmed' }]);
    });
  });

  it('refuses a confirm the balance no longer covers and leaves it pending (WL6)', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await transfer(tx, ids, 10);
      const { request } = await requestShopReturn(tx, jobs, {
        shopId: ids.shopId,
        merchantId: ids.merchantId,
        shopCustomerId: ids.customerId,
        amountUsdUnits: 10 * USD,
        idempotencyKey: newId(),
        actor: merchantActor(ids.merchantId),
      });
      // A purchase in between (S26 PR 2) takes from the wallet first.
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await lockShopCustomerWallet(tx, ids.customerId), amountUnits: -5 * USD },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:correction',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: 5 * USD,
          },
        ],
      });
      const short = await refusal(tx, (inner) =>
        endShopReturn(
          inner,
          jobs,
          request.id,
          { action: 'confirm', shopCustomerId: ids.customerId, idempotencyKey: newId() },
          { kind: 'shop_customer', id: ids.customerId, channel: 'store' },
        ),
      );
      expect(short).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      const [row] = await tx
        .select({ status: shopReturnRequests.status })
        .from(shopReturnRequests)
        .where(eq(shopReturnRequests.id, request.id));
      expect(row?.status).toBe('pending');
      const declined = await endShopReturn(
        tx,
        jobs,
        request.id,
        { action: 'decline', shopCustomerId: ids.customerId },
        { kind: 'shop_customer', id: ids.customerId, channel: 'store' },
      );
      expect(declined.request.status).toBe('declined');
    });
  });

  it('refuses a request above the balance, and lets the merchant cancel one', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await transfer(tx, ids, 5);
      const input = {
        shopId: ids.shopId,
        merchantId: ids.merchantId,
        shopCustomerId: ids.customerId,
        idempotencyKey: newId(),
        actor: merchantActor(ids.merchantId),
      };
      expect(
        await refusal(tx, (inner) =>
          requestShopReturn(inner, jobs, { ...input, amountUsdUnits: 6 * USD }),
        ),
      ).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      const { request } = await requestShopReturn(tx, jobs, { ...input, amountUsdUnits: 5 * USD });
      const cancelled = await endShopReturn(
        tx,
        jobs,
        request.id,
        { action: 'cancel', merchantId: ids.merchantId },
        merchantActor(ids.merchantId),
      );
      expect(cancelled.request.status).toBe('cancelled');
    });
  });

  it('expires pending requests past their 24 hours', async () => {
    const merchantId = await merchant(db);
    const shopId = await shop(db, merchantId);
    const customerId = await shopCustomer(db, shopId);
    const [due] = await db
      .insert(shopReturnRequests)
      .values({
        shopId,
        shopCustomerId: customerId,
        amountUsdUnits: USD,
        expiresAt: new Date(Date.now() - 1000),
        idempotencyKey: newId(),
      })
      .returning();
    const expired = await expireShopReturns(db, jobs);
    expect(expired).toContain(due?.id);
    const [row] = await db
      .select({ status: shopReturnRequests.status })
      .from(shopReturnRequests)
      .where(eq(shopReturnRequests.id, due?.id as string));
    expect(row?.status).toBe('expired');
    expect(await expireShopReturns(db, jobs)).not.toContain(due?.id);
  });
});

describe('closing and settling (SH7, WL9)', () => {
  it('closes the shop on the revocation, cancels its requests and keeps its list', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await transfer(tx, ids, 10);
      const { request } = await requestShopReturn(tx, jobs, {
        shopId: ids.shopId,
        merchantId: ids.merchantId,
        shopCustomerId: ids.customerId,
        amountUsdUnits: USD,
        idempotencyKey: newId(),
        actor: merchantActor(ids.merchantId),
      });
      const customer = await lockCustomer(tx, ids.merchantId);
      await revokeMerchant(tx, { jobs }, customer, {
        reason: 'Revoked in a test',
        actor: { adminId: adminActor.id, ipAddress: null, userAgent: null },
      });
      const [closed] = await tx
        .select()
        .from(merchantShops)
        .where(eq(merchantShops.id, ids.shopId));
      expect(closed?.status).toBe('closed');
      expect(closed?.priceListIdAtClose).not.toBeNull();
      const [cancelled] = await tx
        .select({ status: shopReturnRequests.status })
        .from(shopReturnRequests)
        .where(eq(shopReturnRequests.id, request.id));
      expect(cancelled?.status).toBe('cancelled');
      const alerts = await tx
        .select({ kind: telegramMessages.kind })
        .from(telegramMessages)
        .where(eq(telegramMessages.dedupeKey, `shop-closed:${ids.shopId}`));
      expect(alerts).toEqual([{ kind: 'shop_closed_with_balance' }]);
      expect(
        await closeShop(tx, jobs, {
          shopId: ids.shopId,
          cause: 'admin',
          reason: 'x',
          actor: adminActor,
        }),
      ).toBeNull();
    });
  });

  it('settles a closed shop balance to the merchant or as a cash refund, reconciled (C9)', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      const second = { ...ids, customerId: await shopCustomer(tx, ids.shopId) };
      await transfer(tx, ids, 10);
      await transfer(tx, second, 7);
      const settle = (customerId: string, target: 'merchant' | 'cash_refund', key = newId()) =>
        settleShopCustomer(tx, jobs, {
          shopId: ids.shopId,
          shopCustomerId: customerId,
          target,
          reason: 'Settled in a test',
          idempotencyKey: key,
          actor: adminActor,
        });
      expect(await refusal(tx, () => settle(ids.customerId, 'merchant'))).toMatchObject({
        code: 'SHOP_STATE_INVALID',
      });
      await closeShop(tx, jobs, {
        shopId: ids.shopId,
        cause: 'admin',
        reason: 'Closed',
        actor: adminActor,
      });
      const key = newId();
      const { settlement } = await settle(ids.customerId, 'merchant', key);
      expect(settlement.amountUsdUnits).toBe(10 * USD);
      expect((await settle(ids.customerId, 'merchant', key)).replayed).toBe(true);
      expect(await merchantBalance(tx, ids.merchantId)).toBe(93 * USD);
      const cash = await settle(second.customerId, 'cash_refund');
      expect(cash.settlement.amountUsdUnits).toBe(7 * USD);
      expect(await shopBalance(tx, second.customerId)).toBe(0);
      expect(await refusal(tx, () => settle(second.customerId, 'merchant'))).toMatchObject({
        code: 'CUSTOMER_STATE_INVALID',
      });
      const { results } = await internalChecks(tx);
      const manual = results.find((result) => result.check === 'manual_journals');
      const offending = (manual?.details?.offending ?? []).map((item) => item.id);
      const journals = await tx
        .select({ journalId: shopTransfers.journalId })
        .from(shopTransfers)
        .where(eq(shopTransfers.shopId, ids.shopId));
      for (const id of [
        ...journals.map((row) => row.journalId),
        settlement.journalId,
        cash.settlement.journalId,
      ]) {
        expect(offending).not.toContain(id);
      }
    });
  });

  it('counts shop wallets apart from the customer wallets in the ledger summary', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      await transfer(tx, ids, 12);
      // One snapshot: other files commit shop wallets in parallel, so no delta between two reads.
      const after = await ledgerSummary(tx);
      expect(after.owedToShopCustomersUnits).toBeGreaterThanOrEqual(12 * USD);
      const usdSystem = after.systemAccounts
        .filter((account) => account.currency === 'USD')
        .reduce((sum, account) => sum + account.balanceUnits, 0);
      expect(
        after.owedToCustomersUnits +
          after.owedToTestCustomersUnits +
          after.owedToShopCustomersUnits +
          usdSystem,
      ).toBe(0);
      expect(after.systemAccounts.some((account) => account.kind === 'shop_customer_wallet')).toBe(
        false,
      );
    });
  });
});

describe('guards (migration 0113)', () => {
  it('moves a shop only along the states table and never deletes it', async () => {
    await rolledBack(async (tx) => {
      const merchantId = await merchant(tx, 0);
      const shopId = await shop(tx, merchantId);
      const attempt = (values: Partial<typeof merchantShops.$inferInsert>) =>
        refusal(tx, (inner) =>
          inner.update(merchantShops).set(values).where(eq(merchantShops.id, shopId)),
        );
      expect(text(await attempt({ status: 'requested' }))).toMatch(/not allowed/);
      expect(text(await attempt({ status: 'rejected', rejectReason: 'x' }))).toMatch(/not allowed/);
      expect(text(await attempt({ merchantId: await merchant(tx, 0) }))).toMatch(/fixed/);
      expect(text(await attempt({ priceListIdAtClose: newId() }))).toMatch(/closing list/);
      expect(text(await attempt({ archivedAt: new Date() }))).toMatch(/rejected request/);
      expect(
        text(
          await refusal(tx, (inner) =>
            inner.delete(merchantShops).where(eq(merchantShops.id, shopId)),
          ),
        ),
      ).toMatch(/permission denied|never deleted/);
      expect(
        text(
          await refusal(tx, (inner) =>
            inner.insert(merchantShops).values({
              merchantId,
              slug: `x${newId().slice(-10)}`,
              displayName: 'x',
              brandColor: '#1f7a6c',
              status: 'active',
              decidedAt: new Date(),
            }),
          ),
        ),
      ).toMatch(/starts requested/);
    });
  });

  it('ends a return request once and keeps its amount', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      const [request] = await tx
        .insert(shopReturnRequests)
        .values({
          shopId: ids.shopId,
          shopCustomerId: ids.customerId,
          amountUsdUnits: USD,
          expiresAt: new Date(Date.now() + 3600_000),
          idempotencyKey: newId(),
        })
        .returning();
      const id = request?.id as string;
      const change = (values: Partial<typeof shopReturnRequests.$inferInsert>) =>
        refusal(tx, (inner) =>
          inner.update(shopReturnRequests).set(values).where(eq(shopReturnRequests.id, id)),
        );
      expect(text(await change({ amountUsdUnits: 2 * USD }))).toMatch(/only its end/);
      await tx
        .update(shopReturnRequests)
        .set({ status: 'declined', decidedAt: new Date() })
        .where(eq(shopReturnRequests.id, id));
      expect(text(await change({ status: 'confirmed' }))).toMatch(/ended already/);
    });
  });

  it('keeps transfers append-only and the shop customer in its shop, for the owner too', async () => {
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      const { transfer: row } = await transfer(tx, ids, 1);
      expect(
        text(
          await refusal(tx, (inner) =>
            inner
              .update(shopTransfers)
              .set({ amountUsdUnits: 2 * USD })
              .where(eq(shopTransfers.id, row.id)),
          ),
        ),
      ).toMatch(/permission denied|append-only/);
      expect(
        text(
          await refusal(tx, (inner) =>
            inner.delete(shopCustomers).where(eq(shopCustomers.id, ids.customerId)),
          ),
        ),
      ).toMatch(/permission denied|never deleted/);
    });
    await rolledBack(async (tx) => {
      const ids = await setting(tx);
      const { transfer: row } = await transfer(tx, ids, 1);
      const other = await shop(tx, await merchant(tx, 0));
      expect(
        text(
          await refusal(tx, (inner) =>
            inner.delete(shopTransfers).where(eq(shopTransfers.id, row.id)),
          ),
        ),
      ).toMatch(/append-only/);
      expect(
        text(
          await refusal(tx, (inner) =>
            inner
              .update(shopCustomers)
              .set({ shopId: other })
              .where(eq(shopCustomers.id, ids.customerId)),
          ),
        ),
      ).toMatch(/fixed|violates foreign key/);
    }, owner.db);
  });
});
