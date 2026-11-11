import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminShop,
  type AdminShopQuery,
  type AdminShopRow,
  type ApproveShop,
  rateFromNumeric,
  type SettleShopCustomer,
  type ShopAction,
  type ShopCustomerQuery,
  type ShopSuspendReason,
  shopTransition,
  type UpdateShop,
} from '@vertex-digital/contracts';
import {
  accountMerchant,
  closeShop,
  type Database,
  merchantShopRates,
  merchantShopSlugs,
  merchantShops,
  queueShopRevalidate,
  recordAudit,
  type ShopRow,
  settleShopCustomer,
  shopCustomers,
  shopRateNow,
  shopTotalBalances,
  slugHeldByUnsettledShop,
  type Transaction,
  transferredToday,
} from '@vertex-digital/db';
import { and, count, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { after, cursorTime, decodeCursor, pageOf } from '../../core/lists/cursor.js';
import { AuthService } from '../auth/index.js';
import { NotificationsService } from '../notifications/index.js';
import { shopErrorToHttp } from './shop-errors.js';
import { customerPage, merchantShopOf } from './shops-merchant.service.js';

const notFound = (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`);
const stateInvalid = (status: string) =>
  new CodedException(409, 'SHOP_STATE_INVALID', 'The shop state does not allow this', { status });
const slugTaken = () => new CodedException(409, 'SLUG_TAKEN', 'The slug is taken');

/** The admin as the shop decisions record them. */
export interface ShopAdmin {
  id: string;
}

/**
 * The admin's side of shops (S26 SH1–SH8, CA7, WL9): the list and the shop page, the review,
 * the states, the limits and slug, the settlement of a closed shop and a shop customer's freeze.
 * Each change, its audit entry and the merchant's notification commit together.
 */
@Injectable()
export class ShopsAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
  ) {}

  /** `GET /api/admin/shops`: newest request first, by state, with customers and balances. */
  async list(query: AdminShopQuery): Promise<{ items: AdminShopRow[]; nextCursor: string | null }> {
    const position = query.cursor ? decodeCursor(query.cursor) : null;
    const search = query.q?.trim();
    const pattern = search ? `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
    const rows = await this.db
      .select({
        shop: merchantShops,
        at: cursorTime(merchantShops.requestedAt),
        customers: sql<number>`(select count(*) from shop_customers c
          where c.shop_id = ${merchantShops.id} and c.archived_at is null)::int`,
      })
      .from(merchantShops)
      .where(
        and(
          isNull(merchantShops.archivedAt),
          query.status ? eq(merchantShops.status, query.status) : undefined,
          pattern
            ? or(ilike(merchantShops.slug, pattern), ilike(merchantShops.displayName, pattern))
            : undefined,
          position ? after(merchantShops.requestedAt, merchantShops.id, position) : undefined,
        ),
      )
      .orderBy(desc(merchantShops.requestedAt), desc(merchantShops.id))
      .limit(query.limit + 1);
    const page = pageOf(rows, query.limit, (row) => ({ at: row.at, id: row.shop.id }));
    const shopIds = page.items.map((row) => row.shop.id);
    const totals = await shopTotalBalances(this.db, shopIds);
    const names = await this.auth.namesOf(page.items.map((row) => row.shop.merchantId));
    const items: AdminShopRow[] = [];
    for (const { shop, customers } of page.items) {
      items.push({
        id: shop.id,
        merchantId: shop.merchantId,
        merchantName: names.get(shop.merchantId) ?? '',
        tradeName: shop.displayName,
        slug: shop.slug,
        status: shop.status,
        brandColor: shop.brandColor,
        customerCount: customers,
        totalBalanceUsdUnits: totals.get(shop.id) ?? 0,
        transferredTodayUsdUnits: await transferredToday(this.db, shop.id),
        requestedAt: shop.requestedAt.toISOString(),
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  /** `GET /api/admin/shops/:id`. */
  async shop(id: string): Promise<AdminShop> {
    const [shop] = await this.db.select().from(merchantShops).where(eq(merchantShops.id, id));
    if (!shop) throw notFound('shop');
    return this.adminShop(this.db, shop);
  }

  /** `GET /api/admin/shops/:id/customers`: every customer, with the freeze reason (CA7). */
  async customers(id: string, query: ShopCustomerQuery) {
    const [shop] = await this.db
      .select({ id: merchantShops.id })
      .from(merchantShops)
      .where(eq(merchantShops.id, id));
    if (!shop) throw notFound('shop');
    return customerPage(this.db, shop.id, query);
  }

  /** SH3, SH8: the admin approves a request with its limits, the slug edited if needed. */
  async approve(admin: ShopAdmin, id: string, input: ApproveShop, meta: RequestMeta) {
    let row: ShopRow;
    try {
      row = await this.db.transaction(async (tx) => {
        const shop = await this.lock(tx, id);
        this.move(shop, 'approve');
        const merchant = await accountMerchant(tx, shop.merchantId);
        if (!merchant)
          throw new CodedException(409, 'NOT_MERCHANT', 'The account is not a merchant');
        const slug = input.slug ?? shop.slug;
        await this.assertSlugFree(tx, shop.merchantId, slug);
        const [approved] = await tx
          .update(merchantShops)
          .set({
            status: 'active',
            slug,
            displayName: merchant.tradeName,
            decidedAt: sql`now()`,
            ...input.limits,
          })
          .where(eq(merchantShops.id, shop.id))
          .returning();
        if (!approved) throw new Error('The shop was not approved');
        await tx
          .insert(merchantShopSlugs)
          .values({ slug, shopId: shop.id, merchantId: shop.merchantId })
          .onConflictDoNothing();
        await recordAudit(tx, {
          action: 'shop.approved',
          ...this.byAdmin(admin, shop.id, meta),
          details: { slug, limits: input.limits },
        });
        await this.tell(tx, approved, { status: 'active', resumed: false, reason: null });
        return approved;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
    return this.adminShop(this.db, row);
  }

  /** SH1: the admin rejects a request with a reason the merchant reads. */
  async reject(admin: ShopAdmin, id: string, reason: string, meta: RequestMeta) {
    return this.db
      .transaction(async (tx) => {
        const shop = await this.lock(tx, id);
        this.move(shop, 'reject');
        const [rejected] = await tx
          .update(merchantShops)
          .set({ status: 'rejected', rejectReason: reason, decidedAt: sql`now()` })
          .where(eq(merchantShops.id, shop.id))
          .returning();
        if (!rejected) throw new Error('The shop was not rejected');
        await recordAudit(tx, {
          action: 'shop.rejected',
          ...this.byAdmin(admin, shop.id, meta),
          reason,
          details: {},
        });
        await this.tell(tx, rejected, { status: 'rejected', resumed: false, reason });
        return rejected;
      })
      .then((row) => this.adminShop(this.db, row));
  }

  /** SH6: a read-only shop; the customers see the category, never the note. */
  async suspend(
    admin: ShopAdmin,
    id: string,
    input: { reason: ShopSuspendReason; note: string },
    meta: RequestMeta,
  ) {
    return this.db
      .transaction(async (tx) => {
        const shop = await this.lock(tx, id);
        this.move(shop, 'suspend');
        const [suspended] = await tx
          .update(merchantShops)
          .set({ status: 'suspended', suspendReason: input.reason, suspendNote: input.note })
          .where(eq(merchantShops.id, shop.id))
          .returning();
        if (!suspended) throw new Error('The shop was not suspended');
        await recordAudit(tx, {
          action: 'shop.suspended',
          ...this.byAdmin(admin, shop.id, meta),
          reason: input.note,
          details: { category: input.reason },
        });
        await this.tell(tx, suspended, { status: 'suspended', resumed: false, reason: null });
        return suspended;
      })
      .then((row) => this.adminShop(this.db, row));
  }

  async resume(admin: ShopAdmin, id: string, meta: RequestMeta) {
    return this.db
      .transaction(async (tx) => {
        const shop = await this.lock(tx, id);
        this.move(shop, 'resume');
        const [resumed] = await tx
          .update(merchantShops)
          .set({ status: 'active', suspendReason: null, suspendNote: null })
          .where(eq(merchantShops.id, shop.id))
          .returning();
        if (!resumed) throw new Error('The shop was not resumed');
        await recordAudit(tx, {
          action: 'shop.resumed',
          ...this.byAdmin(admin, shop.id, meta),
          details: {},
        });
        await this.tell(tx, resumed, { status: 'active', resumed: true, reason: null });
        return resumed;
      })
      .then((row) => this.adminShop(this.db, row));
  }

  /** SH7: closed by the admin (re-authenticated); pending requests are cancelled. */
  async close(admin: ShopAdmin, id: string, reason: string, meta: RequestMeta) {
    let row: ShopRow;
    try {
      row = await this.db.transaction(async (tx) => {
        const closed = await closeShop(tx, this.jobs, {
          shopId: id,
          cause: 'admin',
          reason,
          actor: { kind: 'admin', id: admin.id, channel: 'admin', ...meta },
        });
        if (!closed) throw stateInvalid('closed');
        return closed;
      });
    } catch (error) {
      throw shopErrorToHttp(error);
    }
    return this.adminShop(this.db, row);
  }

  /** SH3, SH8, ST5: limits, the slug (the old one stays reserved) and clearing the announcement. */
  async update(admin: ShopAdmin, id: string, input: UpdateShop, meta: RequestMeta) {
    let row: ShopRow;
    try {
      row = await this.db.transaction(async (tx) => {
        const shop = await this.lock(tx, id);
        if (shop.status === 'rejected') throw stateInvalid(shop.status);
        const audit = { ...this.byAdmin(admin, shop.id, meta), reason: input.reason };
        const changes: Partial<typeof merchantShops.$inferInsert> = {};
        if (input.limits) {
          Object.assign(changes, input.limits);
          await recordAudit(tx, {
            action: 'shop.limits_changed',
            ...audit,
            details: { before: limitsOf(shop), after: input.limits },
          });
        }
        if (input.slug !== undefined && input.slug !== shop.slug) {
          // SH3: before approval the review edits it; after, only here, through a ticket.
          if (shop.status === 'requested') throw stateInvalid(shop.status);
          await this.assertSlugFree(tx, shop.merchantId, input.slug);
          changes.slug = input.slug;
          await tx
            .insert(merchantShopSlugs)
            .values({ slug: input.slug, shopId: shop.id, merchantId: shop.merchantId })
            .onConflictDoNothing();
          await recordAudit(tx, {
            action: 'shop.slug_changed',
            ...audit,
            details: { before: { slug: shop.slug }, after: { slug: input.slug } },
          });
        }
        if (input.clearAnnouncement && shop.announcement !== null) {
          changes.announcement = null;
          await recordAudit(tx, {
            action: 'shop.announcement_changed',
            ...audit,
            details: { before: { announcement: shop.announcement }, after: { announcement: null } },
          });
        }
        const [updated] = Object.keys(changes).length
          ? await tx
              .update(merchantShops)
              .set(changes)
              .where(eq(merchantShops.id, shop.id))
              .returning()
          : [shop];
        // A new slug or a cleared announcement shows on the shop's pages (SH3, ST5).
        if (changes.slug !== undefined || changes.announcement !== undefined) {
          await queueShopRevalidate(tx, this.jobs, shop.merchantId);
        }
        return updated ?? shop;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw slugTaken();
      throw error;
    }
    return this.adminShop(this.db, row);
  }

  /** WL9: a closed shop customer's whole balance, to the merchant or as a cash refund. */
  async settle(
    admin: ShopAdmin,
    shopId: string,
    customerId: string,
    input: SettleShopCustomer,
    idempotencyKey: string,
    meta: RequestMeta,
  ) {
    try {
      const { settlement, replayed } = await this.db.transaction((tx) =>
        settleShopCustomer(tx, this.jobs, {
          shopId,
          shopCustomerId: customerId,
          target: input.to,
          reason: input.reason,
          idempotencyKey,
          actor: { kind: 'admin', id: admin.id, channel: 'admin', ...meta },
        }),
      );
      return {
        replayed,
        settlement: {
          shopCustomerId: settlement.shopCustomerId,
          to: settlement.target,
          amountUsdUnits: settlement.amountUsdUnits,
          journalId: settlement.journalId,
        },
      };
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }

  /** CA7: the admin freezes or unfreezes a shop customer, with a reason. */
  async setFrozen(
    admin: ShopAdmin,
    customerId: string,
    frozen: boolean,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [customer] = await tx
        .select()
        .from(shopCustomers)
        .where(eq(shopCustomers.id, customerId))
        .for('no key update');
      if (!customer || customer.archivedAt) throw notFound('shop customer');
      if ((customer.frozenAt !== null) === frozen) {
        throw new CodedException(409, 'CUSTOMER_STATE_INVALID', 'Already so', {
          status: frozen ? 'frozen' : 'active',
        });
      }
      await tx
        .update(shopCustomers)
        .set(
          frozen
            ? { frozenAt: sql`now()`, frozenReason: reason }
            : { frozenAt: null, frozenReason: null },
        )
        .where(eq(shopCustomers.id, customer.id));
      await recordAudit(tx, {
        action: frozen ? 'shop_customer.frozen' : 'shop_customer.unfrozen',
        actorKind: 'admin',
        actorId: admin.id,
        channel: 'admin',
        entityType: 'shop_customer',
        entityId: customer.id,
        reason,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {},
      });
    });
  }

  private async lock(tx: Transaction, id: string): Promise<ShopRow> {
    const [shop] = await tx
      .select()
      .from(merchantShops)
      .where(eq(merchantShops.id, id))
      .for('no key update');
    if (!shop || shop.archivedAt) throw notFound('shop');
    return shop;
  }

  private move(shop: ShopRow, action: ShopAction): void {
    if (shopTransition(shop.status, action) === null) throw stateInvalid(shop.status);
  }

  /** SH2: no other merchant holds or held the slug, live or in `merchant_shop_slugs`. */
  private async assertSlugFree(tx: Transaction, merchantId: string, slug: string) {
    const [held] = await tx
      .select({ merchantId: merchantShopSlugs.merchantId })
      .from(merchantShopSlugs)
      .where(eq(merchantShopSlugs.slug, slug));
    if (held && held.merchantId !== merchantId) throw slugTaken();
    if (await slugHeldByUnsettledShop(tx, merchantId, slug)) throw slugTaken();
  }

  private async tell(
    tx: Transaction,
    shop: ShopRow,
    params: { status: ShopRow['status']; resumed: boolean; reason: string | null },
  ) {
    await this.notifications.notifyCustomer(tx, {
      customerId: shop.merchantId,
      event: 'merchant_shop_changed',
      params,
    }); // The shop's pages show its state (a suspension's banner, the close).
    await queueShopRevalidate(tx, this.jobs, shop.merchantId);
  }

  private async adminShop(db: Database | Transaction, shop: ShopRow): Promise<AdminShop> {
    const rate = await shopRateNow(db, shop);
    const today = await transferredToday(db, shop.id);
    const [customers] = await db
      .select({ total: count() })
      .from(shopCustomers)
      .where(and(eq(shopCustomers.shopId, shop.id), isNull(shopCustomers.archivedAt)));
    const totals = await shopTotalBalances(db, [shop.id]);
    const slugs = await db
      .select({ slug: merchantShopSlugs.slug })
      .from(merchantShopSlugs)
      .where(eq(merchantShopSlugs.shopId, shop.id));
    const rates = await db
      .select()
      .from(merchantShopRates)
      .where(eq(merchantShopRates.shopId, shop.id))
      .orderBy(desc(merchantShopRates.createdAt), desc(merchantShopRates.id))
      .limit(50);
    const names = await this.auth.namesOf([shop.merchantId]);
    const total = totals.get(shop.id) ?? 0;
    return {
      ...merchantShopOf(shop, rate, today, customers?.total ?? 0),
      suspendReason: shop.suspendReason,
      rejectReason: shop.rejectReason,
      merchantId: shop.merchantId,
      merchantName: names.get(shop.merchantId) ?? '',
      suspendNote: shop.suspendNote,
      closedAt: shop.closedAt?.toISOString() ?? null,
      totalBalanceUsdUnits: total,
      settled: shop.status === 'closed' && total === 0,
      oldSlugs: slugs.map((row) => row.slug).filter((slug) => slug !== shop.slug),
      rates: rates.map((row) => ({
        rate: rateFromNumeric(row.rateSypPerUsd),
        confirmedFar: row.confirmedFar,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  private byAdmin(admin: ShopAdmin, shopId: string, meta: RequestMeta) {
    return {
      actorKind: 'admin',
      actorId: admin.id,
      channel: 'admin',
      entityType: 'merchant_shop',
      entityId: shopId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    } as const;
  }
}

const limitsOf = (shop: ShopRow) => ({
  customerBalanceCapUsdUnits: shop.customerBalanceCapUsdUnits,
  dailyTransferCapUsdUnits: shop.dailyTransferCapUsdUnits,
  customerLimit: shop.customerLimit,
});
