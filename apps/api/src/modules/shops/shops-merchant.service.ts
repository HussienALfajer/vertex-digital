import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateShopCustomer,
  type MerchantShop,
  type RequestShop,
  type ReturnRequest,
  rateFromNumeric,
  SHOP_REQUEST_AGAIN_DAYS,
  type ShopCustomerPage,
  type ShopCustomerQuery,
  type ShopCustomerRow,
  type ShopSettings,
  type ShopTransfer,
  type ShopTransferResult,
  shopCustomerState,
  shopRateIsFar,
  shopRequestAgainAt,
  type UpdateShopCustomer,
} from '@vertex-digital/contracts';
import {
  accountMerchant,
  applicant,
  type Database,
  endShopReturn,
  merchantShopHiddenGames,
  merchantShopRates,
  merchantShopSlugs,
  merchantShops,
  queueTelegramMessage,
  recordAudit,
  requestShopReturn,
  type ShopRow,
  shopCustomerAccounts,
  shopCustomerBalances,
  shopCustomers,
  shopRateNow,
  shopReturnRequests,
  slugHeldByUnsettledShop,
  storeRateNow,
  type Transaction,
  transferredToday,
  transferToShopCustomer,
  withinLimits,
} from '@vertex-digital/db';
import { and, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AuthService } from '../auth/index.js';
import { ShopAccountsService } from './shop-accounts.service.js';
import { shopErrorToHttp } from './shop-errors.js';

/** The merchant as the shop routes see them. */
export interface ShopMerchant {
  id: string;
  sessionId: string;
}

const notFound = (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`);
const stateInvalid = (status: string, details: Record<string, unknown> = {}) =>
  new CodedException(409, 'SHOP_STATE_INVALID', 'The shop state does not allow this', {
    status,
    ...details,
  });

/** CA1: "إعادة إرسال الدعوة" at most 3 times a Damascus day per customer. */
const inviteLimit = (shopCustomerId: string) => ({
  key: `shop:invite-day:${shopCustomerId}`,
  max: 3,
  windowMs: 24 * 3600 * 1000,
});

/** A merchant's own shop row in the merchant area: the newest that is not archived. */
const LIVE = ['requested', 'active', 'suspended'] as const;

/**
 * The merchant's side of a shop (S26 SH1–SH3, ST1–ST6, CA1, CA3, CA6, CA8, WL1–WL5): the request
 * and settings, hidden games, the shop's customers, invitations, the transfer check, transfers and
 * return requests. Money goes through the write paths of `packages/db` (`shops`).
 */
@Injectable()
export class ShopsMerchantService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly accounts: ShopAccountsService,
    private readonly jobs: JobsService,
    private readonly auth: AuthService,
  ) {}

  /** `GET /api/merchant/shop`: the merchant's shop, or null before a request. */
  async shopOf(merchantId: string): Promise<MerchantShop | null> {
    await this.requireMerchant(merchantId);
    const shop = await this.newestShop(this.db, merchantId);
    return shop ? this.merchantShop(this.db, shop) : null;
  }

  /** The request form's live check (SH2): no other merchant's shop holds or held the slug. */
  async slugAvailable(merchantId: string, slug: string): Promise<boolean> {
    await this.requireMerchant(merchantId);
    return this.slugFree(this.db, merchantId, slug);
  }

  /** `POST /api/merchant/shop` (SH1–SH3, ST1, ST3): a repeated request answers the same shop. */
  async request(
    merchantId: string,
    input: RequestShop & { rate: string | null; confirmFar: boolean },
    meta: RequestMeta,
  ): Promise<{ shop: MerchantShop; replayed: boolean }> {
    await this.requireMerchant(merchantId, true);
    const merchant = await accountMerchant(this.db, merchantId);
    if (!merchant) throw new CodedException(403, 'NOT_MERCHANT', 'The account is not a merchant');
    if (!merchant.termsAccepted) {
      throw new CodedException(403, 'MERCHANT_TERMS_REQUIRED', 'Accept the merchant terms first');
    }
    try {
      return await this.db.transaction(async (tx) => {
        const existing = await this.newestShop(tx, merchantId, true);
        if (existing && (LIVE as readonly string[]).includes(existing.status)) {
          if (existing.slug === input.slug && existing.status === 'requested') {
            return { shop: await this.merchantShop(tx, existing), replayed: true };
          }
          throw stateInvalid(existing.status);
        }
        if (existing?.status === 'rejected' && existing.decidedAt) {
          const again = shopRequestAgainAt(existing.decidedAt);
          if (again.getTime() > Date.now()) {
            throw stateInvalid('rejected', { requestAgainAt: again.toISOString() });
          }
          await tx
            .update(merchantShops)
            .set({ archivedAt: sql`now()` })
            .where(eq(merchantShops.id, existing.id));
        }
        if (!(await this.slugFree(tx, merchantId, input.slug))) throw slugTaken();
        const { storeRate, storeRateId } = await storeRateNow(tx);
        if (input.rateMode === 'own' && input.rate !== null) {
          if (shopRateIsFar(storeRate, input.rate) && !input.confirmFar) throw farRate(storeRate);
        }
        const [shop] = await tx
          .insert(merchantShops)
          .values({
            merchantId,
            slug: input.slug,
            displayName: merchant.tradeName,
            brandColor: input.brandColor,
            rateMode: input.rateMode,
          })
          .returning();
        if (!shop) throw new Error('The shop was not written');
        if (input.rateMode === 'own' && input.rate !== null) {
          await tx.insert(merchantShopRates).values({
            shopId: shop.id,
            rateSypPerUsd: input.rate,
            storeRateId,
            confirmedFar: shopRateIsFar(storeRate, input.rate),
          });
        }
        await recordAudit(tx, {
          action: 'shop.requested',
          ...this.byMerchant(merchantId, shop.id, meta),
          details: {
            slug: shop.slug,
            brandColor: shop.brandColor,
            rateMode: shop.rateMode,
            rate: input.rateMode === 'own' ? input.rate : null,
            confirmedFar:
              input.rateMode === 'own' &&
              input.rate !== null &&
              shopRateIsFar(storeRate, input.rate),
          },
        });
        const [waiting] = await tx
          .select({ total: count() })
          .from(merchantShops)
          .where(eq(merchantShops.status, 'requested'));
        await queueTelegramMessage(tx, this.jobs, {
          kind: 'shop_requested',
          params: { shopId: shop.id, slug: shop.slug, waiting: Math.max(waiting?.total ?? 1, 1) },
          dedupeKey: `shop-requested:${shop.id}`,
        });
        return { shop: await this.merchantShop(tx, shop), replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
  }

  /** `PATCH /api/merchant/shop` (ST1, ST3, ST5): each change audited; a far rate needs `confirmFar`. */
  async updateSettings(
    merchantId: string,
    input: ShopSettings,
    meta: RequestMeta,
  ): Promise<MerchantShop> {
    await this.requireMerchant(merchantId, true);
    return this.db.transaction(async (tx) => {
      const shop = await this.lockLiveShop(tx, merchantId);
      const audit = this.byMerchant(merchantId, shop.id, meta);
      const changes: Partial<typeof merchantShops.$inferInsert> = {};
      if (input.brandColor !== undefined && input.brandColor !== shop.brandColor) {
        changes.brandColor = input.brandColor;
        await recordAudit(tx, {
          action: 'shop.color_changed',
          ...audit,
          details: {
            before: { brandColor: shop.brandColor },
            after: { brandColor: input.brandColor },
          },
        });
      }
      if (input.announcement !== undefined && input.announcement !== shop.announcement) {
        changes.announcement = input.announcement;
        await recordAudit(tx, {
          action: 'shop.announcement_changed',
          ...audit,
          details: {
            before: { announcement: shop.announcement },
            after: { announcement: input.announcement },
          },
        });
      }
      if (input.rateMode !== undefined || input.rate !== undefined) {
        const now = await shopRateNow(tx, shop);
        const mode = input.rateMode ?? shop.rateMode;
        if (mode === 'own' && input.rate === undefined && now.ownRate === null) {
          throw new CodedException(400, 'VALIDATION_FAILED', 'A rate is required', [
            { path: ['rate'], message: 'A rate is required with an own rate' },
          ]);
        }
        const far = input.rate !== undefined && shopRateIsFar(now.storeRate, input.rate);
        if (far && !input.confirmFar) throw farRate(now.storeRate);
        if (input.rate !== undefined) {
          await tx.insert(merchantShopRates).values({
            shopId: shop.id,
            rateSypPerUsd: input.rate,
            storeRateId: now.storeRateId,
            confirmedFar: far,
          });
        }
        changes.rateMode = mode;
        await recordAudit(tx, {
          action: 'shop.rate_changed',
          ...audit,
          details: {
            before: { rateMode: shop.rateMode, rate: now.ownRate },
            after: { rateMode: mode, rate: input.rate ?? now.ownRate },
            confirmedFar: far,
          },
        });
      }
      const [updated] = Object.keys(changes).length
        ? await tx
            .update(merchantShops)
            .set(changes)
            .where(eq(merchantShops.id, shop.id))
            .returning()
        : [shop];
      return this.merchantShop(tx, updated ?? shop);
    });
  }

  /** `PUT /api/merchant/shop/hidden-games` (ST6): the whole list; unknown games are `NOT_FOUND`. */
  async setHiddenGames(merchantId: string, gameIds: string[], meta: RequestMeta) {
    await this.requireMerchant(merchantId, true);
    const wanted = [...new Set(gameIds.map((id) => id.toLowerCase()))];
    try {
      return await this.db.transaction(async (tx) => {
        const shop = await this.lockLiveShop(tx, merchantId);
        const rows = await tx
          .select({ gameId: merchantShopHiddenGames.gameId })
          .from(merchantShopHiddenGames)
          .where(eq(merchantShopHiddenGames.shopId, shop.id));
        const before = new Set(rows.map((row) => row.gameId));
        const added = wanted.filter((id) => !before.has(id));
        const removed = [...before].filter((id) => !wanted.includes(id));
        if (removed.length) {
          await tx
            .delete(merchantShopHiddenGames)
            .where(
              and(
                eq(merchantShopHiddenGames.shopId, shop.id),
                inArray(merchantShopHiddenGames.gameId, removed),
              ),
            );
        }
        if (added.length) {
          await tx
            .insert(merchantShopHiddenGames)
            .values(added.map((gameId) => ({ shopId: shop.id, gameId })));
        }
        if (added.length || removed.length) {
          await recordAudit(tx, {
            action: 'shop.hidden_games_changed',
            ...this.byMerchant(merchantId, shop.id, meta),
            details: { added, removed },
          });
        }
        return { gameIds: wanted };
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('game');
      throw error;
    }
  }

  /** `GET /api/merchant/shop/hidden-games`. */
  async hiddenGames(merchantId: string): Promise<{ gameIds: string[] }> {
    await this.requireMerchant(merchantId);
    const shop = await this.newestShop(this.db, merchantId);
    if (!shop) return { gameIds: [] };
    const rows = await this.db
      .select({ gameId: merchantShopHiddenGames.gameId })
      .from(merchantShopHiddenGames)
      .where(eq(merchantShopHiddenGames.shopId, shop.id));
    return { gameIds: rows.map((row) => row.gameId) };
  }

  /** `GET /api/merchant/shop/customers`: newest first, with balance and pending return (TK4). */
  async customers(merchantId: string, query: ShopCustomerQuery): Promise<ShopCustomerPage> {
    await this.requireMerchant(merchantId);
    const shop = await this.newestShop(this.db, merchantId);
    if (!shop || shop.status === 'rejected' || shop.status === 'requested') {
      return { items: [], nextCursor: null };
    }
    return customerPage(this.db, shop.id, query);
  }

  /** `POST /api/merchant/shop/customers` (CA1, CA3, CA6): the account and its invitation. */
  async createCustomer(
    merchantId: string,
    input: CreateShopCustomer & { phone: string },
    meta: RequestMeta,
  ): Promise<ShopCustomerRow> {
    await this.requireMerchant(merchantId, true);
    const email = input.email.trim().toLowerCase();
    try {
      return await this.db.transaction(async (tx) => {
        const shop = await this.lockLiveShop(tx, merchantId);
        if (shop.status !== 'active') {
          throw new CodedException(403, 'SHOP_UNAVAILABLE', 'The shop takes no new customers');
        }
        const [existing] = await tx
          .select({ id: shopCustomers.id })
          .from(shopCustomers)
          .where(and(eq(shopCustomers.shopId, shop.id), eq(shopCustomers.email, email)));
        if (existing) throw emailTaken();
        await this.accounts.assertRoom(tx, shop);
        const [customer] = await tx
          .insert(shopCustomers)
          .values({
            shopId: shop.id,
            name: input.name,
            email,
            phone: input.phone,
            createdBy: 'merchant',
          })
          .returning();
        if (!customer) throw new Error('The shop customer was not written');
        await recordAudit(tx, {
          action: 'shop_customer.created',
          ...this.byMerchant(merchantId, shop.id, meta),
          entityType: 'shop_customer',
          entityId: customer.id,
          details: {
            shopId: shop.id,
            name: customer.name,
            email,
            phone: customer.phone,
            origin: 'merchant',
          },
        });
        await this.accounts.invite(tx, shop, customer, { ...meta, actorId: merchantId });
        const [row] = (await customerPage(tx, shop.id, { limit: 1 }, customer.id)).items;
        if (!row) throw new Error('The shop customer cannot be read');
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
  }

  /** `PATCH /api/merchant/shop/customers/:id` (CA8): name and phone. */
  async updateCustomer(
    merchantId: string,
    customerId: string,
    input: UpdateShopCustomer & { phone?: string },
    meta: RequestMeta,
  ): Promise<ShopCustomerRow> {
    await this.requireMerchant(merchantId, true);
    return this.db.transaction(async (tx) => {
      const shop = await this.newestShop(tx, merchantId);
      if (!shop) throw notFound('shop customer');
      const customer = await this.customerOf(tx, shop.id, customerId, true);
      const before = { name: customer.name, phone: customer.phone };
      const after = { name: input.name ?? customer.name, phone: input.phone ?? customer.phone };
      if (before.name !== after.name || before.phone !== after.phone) {
        await tx.update(shopCustomers).set(after).where(eq(shopCustomers.id, customer.id));
        await recordAudit(tx, {
          action: 'shop_customer.profile_updated',
          ...this.byMerchant(merchantId, shop.id, meta),
          entityType: 'shop_customer',
          entityId: customer.id,
          details: { before, after },
        });
      }
      const [row] = (await customerPage(tx, shop.id, { limit: 1 }, customer.id)).items;
      if (!row) throw notFound('shop customer');
      return row;
    });
  }

  /** `POST /api/merchant/shop/customers/:id/invite` (CA1): a new link, 3 a day, before a password. */
  async reinvite(merchantId: string, customerId: string, meta: RequestMeta): Promise<void> {
    await this.requireMerchant(merchantId, true);
    const shop = await this.newestShop(this.db, merchantId);
    if (shop?.status !== 'active') {
      throw new CodedException(403, 'SHOP_UNAVAILABLE', 'The shop is not active');
    }
    const customer = await this.customerOf(this.db, shop.id, customerId);
    const [account] = await this.db
      .select({ id: shopCustomerAccounts.id })
      .from(shopCustomerAccounts)
      .where(eq(shopCustomerAccounts.userId, customer.id));
    if (account) {
      throw new CodedException(409, 'CUSTOMER_STATE_INVALID', 'The customer has a password');
    }
    if (!(await withinLimits(this.db, [inviteLimit(customer.id)]))) {
      throw new CodedException(429, 'RATE_LIMITED', 'Three invitations a day');
    }
    await this.db.transaction((tx) =>
      this.accounts.invite(tx, shop, customer, { ...meta, actorId: merchantId }),
    );
  }

  /** `POST /api/merchant/shop/transfer-check` (WL4): the password opens 15 minutes. */
  async confirmForTransfers(merchant: ShopMerchant, password: string): Promise<Date> {
    await this.requireMerchant(merchant.id, true);
    return this.auth.confirmForTransfers(merchant, password);
  }

  /** `POST /api/merchant/shop/customers/:id/transfers` (WL1–WL4). */
  async transfer(
    merchant: ShopMerchant,
    customerId: string,
    input: ShopTransfer,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<{ result: ShopTransferResult; replayed: boolean }> {
    await this.requireMerchant(merchant.id, true);
    const shop = await this.newestShop(this.db, merchant.id);
    if (!shop) throw notFound('shop customer');
    await this.customerOf(this.db, shop.id, customerId);
    if (!(await this.auth.recentlyConfirmed(merchant))) {
      throw new CodedException(403, 'REAUTHENTICATION_REQUIRED', 'Confirm your password first');
    }
    try {
      const outcome = await this.db.transaction((tx) =>
        transferToShopCustomer(tx, this.jobs, {
          shopId: shop.id,
          merchantId: merchant.id,
          shopCustomerId: customerId,
          currency: input.currency,
          amountUnits: input.amountUnits,
          expectedUsdUnits: input.expectedUsdUnits,
          idempotencyKey,
          actor: { kind: 'customer', id: merchant.id, channel: 'store', ...meta },
        }),
      );
      const { transfer } = outcome;
      return {
        replayed: outcome.replayed,
        result: {
          id: transfer.id,
          amountUsdUnits: transfer.amountUsdUnits,
          enteredCurrency: transfer.enteredCurrency,
          enteredAmountUnits: transfer.enteredAmountUnits,
          rate: transfer.rateSypPerUsd === null ? null : rateFromNumeric(transfer.rateSypPerUsd),
          customerBalanceUsdUnits: outcome.customerBalanceUsdUnits,
          merchantBalanceUsdUnits: outcome.merchantBalanceUsdUnits,
          transferredTodayUsdUnits: outcome.transferredTodayUsdUnits,
          createdAt: transfer.createdAt.toISOString(),
        },
      };
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }

  /** `POST /api/merchant/shop/customers/:id/return-requests` (WL5). */
  async requestReturn(
    merchantId: string,
    customerId: string,
    amountUsdUnits: number,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<{ request: ReturnRequest; replayed: boolean }> {
    await this.requireMerchant(merchantId, true);
    const shop = await this.newestShop(this.db, merchantId);
    if (!shop) throw notFound('shop customer');
    try {
      const { request, replayed } = await this.db.transaction((tx) =>
        requestShopReturn(tx, this.jobs, {
          shopId: shop.id,
          merchantId,
          shopCustomerId: customerId,
          amountUsdUnits,
          idempotencyKey,
          actor: { kind: 'customer', id: merchantId, channel: 'store', ...meta },
        }),
      );
      return { request: returnRequestOf(request), replayed };
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }

  /** `DELETE /api/merchant/shop/customers/:id/return-requests/:requestId` (WL5). */
  async cancelReturn(
    merchantId: string,
    customerId: string,
    requestId: string,
    meta: RequestMeta,
  ): Promise<ReturnRequest> {
    await this.requireMerchant(merchantId);
    const [request] = await this.db
      .select({ shopCustomerId: shopReturnRequests.shopCustomerId })
      .from(shopReturnRequests)
      .where(eq(shopReturnRequests.id, requestId));
    if (request?.shopCustomerId !== customerId) throw notFound('return request');
    try {
      const ended = await this.db.transaction((tx) =>
        endShopReturn(
          tx,
          this.jobs,
          requestId,
          { action: 'cancel', merchantId },
          {
            kind: 'customer',
            id: merchantId,
            channel: 'store',
            ...meta,
          },
        ),
      );
      return returnRequestOf(ended.request);
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }

  private async requireMerchant(merchantId: string, write = false): Promise<void> {
    const person = await applicant(this.db, merchantId);
    if (person?.accountType !== 'merchant') {
      throw new CodedException(403, 'NOT_MERCHANT', 'The account is not a merchant');
    }
    if (write && (person.frozenAt !== null || person.archivedAt !== null)) {
      throw new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen');
    }
  }

  /** The merchant's newest shop that is not archived; with `lock`, `FOR NO KEY UPDATE`. */
  private async newestShop(
    db: Database | Transaction,
    merchantId: string,
    lock = false,
  ): Promise<ShopRow | null> {
    const query = db
      .select()
      .from(merchantShops)
      .where(and(eq(merchantShops.merchantId, merchantId), isNull(merchantShops.archivedAt)))
      .orderBy(desc(merchantShops.requestedAt), desc(merchantShops.id))
      .limit(1);
    const [row] = lock ? await query.for('no key update') : await query;
    return row ?? null;
  }

  /** The merchant's live shop `FOR NO KEY UPDATE` (settings change while requested, active, suspended). */
  private async lockLiveShop(tx: Transaction, merchantId: string): Promise<ShopRow> {
    const shop = await this.newestShop(tx, merchantId, true);
    if (!shop) throw notFound('shop');
    if (!(LIVE as readonly string[]).includes(shop.status)) throw stateInvalid(shop.status);
    return shop;
  }

  private async customerOf(
    db: Database | Transaction,
    shopId: string,
    customerId: string,
    lock = false,
  ) {
    const query = db
      .select()
      .from(shopCustomers)
      .where(
        and(
          eq(shopCustomers.id, customerId),
          eq(shopCustomers.shopId, shopId),
          isNull(shopCustomers.archivedAt),
        ),
      );
    const [row] = lock ? await query.for('no key update') : await query;
    if (!row) throw notFound('shop customer');
    return row;
  }

  /** SH2: no live shop of another merchant has the slug, and no shop of another merchant held it. */
  private async slugFree(db: Database | Transaction, merchantId: string, slug: string) {
    const [held] = await db
      .select({ merchantId: merchantShopSlugs.merchantId })
      .from(merchantShopSlugs)
      .where(eq(merchantShopSlugs.slug, slug));
    if (held && held.merchantId !== merchantId) return false;
    if (await slugHeldByUnsettledShop(db, merchantId, slug)) return false;
    const [live] = await db
      .select({ id: merchantShops.id })
      .from(merchantShops)
      .where(
        and(
          eq(merchantShops.slug, slug),
          inArray(merchantShops.status, [...LIVE]),
          ne(merchantShops.merchantId, merchantId),
        ),
      );
    return !live;
  }

  private async merchantShop(db: Database | Transaction, shop: ShopRow): Promise<MerchantShop> {
    const rate = await shopRateNow(db, shop);
    const today = await transferredToday(db, shop.id);
    const [customers] = await db
      .select({ total: count() })
      .from(shopCustomers)
      .where(and(eq(shopCustomers.shopId, shop.id), isNull(shopCustomers.archivedAt)));
    return merchantShopOf(shop, rate, today, customers?.total ?? 0);
  }

  private byMerchant(merchantId: string, shopId: string, meta: RequestMeta) {
    return {
      actorKind: 'customer',
      actorId: merchantId,
      channel: 'store',
      entityType: 'merchant_shop',
      entityId: shopId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}

/** A shop as its merchant sees it; the admin's view extends it. */
export function merchantShopOf(
  shop: ShopRow,
  rate: { rate: string | null; ownRate: string | null },
  transferredTodayUsdUnits: number,
  customerCount: number,
): MerchantShop {
  return {
    id: shop.id,
    slug: shop.slug,
    status: shop.status,
    displayName: shop.displayName,
    brandColor: shop.brandColor,
    announcement: shop.announcement,
    rateMode: shop.rateMode,
    ownRate: rate.ownRate,
    rate: rate.rate,
    limits: {
      customerBalanceCapUsdUnits: shop.customerBalanceCapUsdUnits,
      dailyTransferCapUsdUnits: shop.dailyTransferCapUsdUnits,
      customerLimit: shop.customerLimit,
    },
    transferredTodayUsdUnits,
    customerCount,
    rejectReason: shop.status === 'rejected' ? shop.rejectReason : null,
    suspendReason: shop.status === 'suspended' ? shop.suspendReason : null,
    requestedAt: shop.requestedAt.toISOString(),
    decidedAt: shop.decidedAt?.toISOString() ?? null,
    requestAgainAt:
      shop.status === 'rejected' && shop.decidedAt
        ? new Date(
            shop.decidedAt.getTime() + SHOP_REQUEST_AGAIN_DAYS * 24 * 3600 * 1000,
          ).toISOString()
        : null,
  };
}

export function returnRequestOf(row: typeof shopReturnRequests.$inferSelect): ReturnRequest {
  return {
    id: row.id,
    amountUsdUnits: row.amountUsdUnits,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A page of a shop's customers, newest first, with balances and pending requests; one by id. */
export async function customerPage(
  db: Database | Transaction,
  shopId: string,
  query: { cursor?: string; limit: number; q?: string },
  onlyId?: string,
): Promise<{
  items: (ShopCustomerRow & { frozenReason: string | null })[];
  nextCursor: string | null;
}> {
  const position = query.cursor ? decodeCursor(query.cursor) : null;
  const search = query.q?.trim();
  const pattern = search ? `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const rows = await db
    .select({
      customer: shopCustomers,
      at: cursorTime(shopCustomers.createdAt),
      hasPassword: sql<boolean>`exists (select 1 from shop_customer_accounts a
        where a.user_id = ${shopCustomers.id} and a.password is not null)`,
    })
    .from(shopCustomers)
    .where(
      and(
        eq(shopCustomers.shopId, shopId),
        onlyId ? eq(shopCustomers.id, onlyId) : undefined,
        pattern
          ? or(
              ilike(shopCustomers.name, pattern),
              ilike(shopCustomers.email, pattern),
              ilike(shopCustomers.phone, pattern),
            )
          : undefined,
        position ? after(shopCustomers.createdAt, shopCustomers.id, position) : undefined,
      ),
    )
    .orderBy(desc(shopCustomers.createdAt), desc(shopCustomers.id))
    .limit(query.limit + 1);
  const page = pageOf(rows, query.limit, (row) => ({ at: row.at, id: row.customer.id }));
  const ids = page.items.map((row) => row.customer.id);
  const balances = await shopCustomerBalances(db, ids);
  const pending = ids.length
    ? await db
        .select()
        .from(shopReturnRequests)
        .where(
          and(
            inArray(shopReturnRequests.shopCustomerId, ids),
            eq(shopReturnRequests.status, 'pending'),
          ),
        )
    : [];
  return {
    nextCursor: page.nextCursor,
    items: page.items.map(({ customer, hasPassword }) => {
      const request = pending.find((row) => row.shopCustomerId === customer.id);
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        state: shopCustomerState({ ...customer, hasPassword }),
        origin: customer.createdBy,
        balanceUsdUnits: balances.get(customer.id) ?? 0,
        pendingReturn: request
          ? {
              id: request.id,
              amountUsdUnits: request.amountUsdUnits,
              expiresAt: request.expiresAt.toISOString(),
            }
          : null,
        createdAt: customer.createdAt.toISOString(),
        frozenReason: customer.frozenReason,
      };
    }),
  };
}

const slugTaken = () => new CodedException(409, 'SLUG_TAKEN', 'The slug is taken');
const emailTaken = () => new CodedException(409, 'EMAIL_TAKEN', 'The email has an account here');
const farRate = (storeRate: string | null) =>
  new CodedException(409, 'SHOP_RATE_CONFIRMATION_REQUIRED', 'The rate is far from the store', {
    storeRate,
  });

function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ((current as { code?: unknown }).code === '23503') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
