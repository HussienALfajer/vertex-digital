import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type MerchantShopOrderPage,
  type MerchantShopOrderQuery,
  orderNumberSchema,
  type PlayerCheck,
  type PlayerCheckRequest,
  type RevealedCode,
  SHOP_STICKERS_PER_HOUR,
  type ShopCompensation,
  type ShopCompensationRequest,
  type ShopOrder,
  type ShopOrderListQuery,
  type ShopOrderPage,
  type ShopPurchase,
  type ShopStats,
  type ShopStatsQuery,
  type ShopStickerSize,
  zoneDate,
  zoneDayStart,
  zoneMonthStart,
  zoneYearMonth,
} from '@vertex-digital/contracts';
import {
  compensateShopOrder,
  type Database,
  merchantShopOrderPage,
  merchantShops,
  orderCodesKey,
  purchaseShopOrder,
  receiptSettingsOf,
  revealCode,
  shopCustomerOrder,
  shopCustomerOrderPage,
  shopStatsDays,
  withinLimits,
} from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { decodeCursor, encodeCursor } from '../../core/lists/cursor.js';
import { AuthService } from '../auth/index.js';
import { FilesService } from '../files/index.js';
import { PlayerChecksService } from '../orders/index.js';
import { SettingsService } from '../settings/index.js';
import type { ShopCustomerIdentity } from './shop-auth.service.js';
import { shopErrorToHttp } from './shop-errors.js';
import { renderShopSticker } from './shop-sticker.js';
import { ShopsMerchantService } from './shops-merchant.service.js';

const TEN_MINUTES = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const notFound = (what = 'order') => new CodedException(404, 'NOT_FOUND', `No such ${what}`);
const rateLimited = () => new CodedException(429, 'RATE_LIMITED', 'Too many requests, try later');

/** PR5: the canonical body behind the key (rule O1's request hash). */
export function shopPurchaseHash(body: ShopPurchase & { fields: Record<string, string> }): string {
  const fields = Object.entries(body.fields).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(
      JSON.stringify([
        body.productId,
        body.quantity,
        fields,
        body.expectedUnitSellUsdUnits,
        body.confirmPlayer ?? false,
      ]),
    )
    .digest('hex');
}

/**
 * Selling in the shop (S26 PR5–PR12, SP2, SP3): the shop customer's purchase through
 * `purchaseShopOrder` under the switches' shared lock, the customer's orders and code reveals at
 * the selling price, the player check, the admin's compensation, and the merchant's shop orders,
 * statistics and sticker. Every shop customer read is the customer's own, in the path's shop.
 */
@Injectable()
export class ShopSellingService {
  private readonly codesKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly playerChecks: PlayerChecksService,
    private readonly merchants: ShopsMerchantService,
    private readonly accounts: AuthService,
    private readonly files: FilesService,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET as string);
  }

  /** `POST /api/shops/:slug/orders` (PR5–PR7): `created` is false for a replayed key. */
  async purchase(
    customer: ShopCustomerIdentity,
    idempotencyKey: string,
    body: ShopPurchase & { fields: Record<string, string>; confirmPlayer: boolean },
    meta: RequestMeta,
  ): Promise<{ order: ShopOrder; created: boolean }> {
    if (customer.frozen) throw new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen');
    const allowed = await withinLimits(this.db, [
      { key: `order:shop-customer:${customer.id}`, max: 10, windowMs: TEN_MINUTES },
      { key: `order:ip:${meta.ipAddress ?? 'unknown'}`, max: 30, windowMs: TEN_MINUTES },
    ]);
    if (!allowed) throw rateLimited();
    try {
      const { order, created } = await this.db.transaction(async (tx) => {
        const switches = await this.settings.valuesForCreation(tx);
        return purchaseShopOrder(
          tx,
          { jobs: this.jobs, now: new Date() },
          {
            shopId: customer.shopId,
            shopCustomerId: customer.id,
            productId: body.productId,
            quantity: body.quantity,
            fields: body.fields,
            expectedUnitSellUsdUnits: body.expectedUnitSellUsdUnits,
            confirmPlayer: body.confirmPlayer,
            idempotencyKey,
            requestHash: shopPurchaseHash(body),
            fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
            purchasesStopped: switches.purchases_stopped,
            playerCheck: (inner, order) => this.playerChecks.lookup(inner, order),
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
        );
      });
      return { order: await this.order(customer, order.number), created };
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }

  /** `GET /api/shops/:slug/orders`: newest first. */
  async orders(customer: ShopCustomerIdentity, query: ShopOrderListQuery): Promise<ShopOrderPage> {
    const page = await shopCustomerOrderPage(this.db, customer.id, {
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    return {
      items: page.items,
      nextCursor: page.more && page.last ? encodeCursor(page.last) : null,
    };
  }

  /** `GET /api/shops/:slug/orders/:number`: another customer's order is not found. */
  async order(customer: ShopCustomerIdentity, number: string): Promise<ShopOrder> {
    const parsed = orderNumberSchema.safeParse(number);
    const order = parsed.success
      ? await shopCustomerOrder(this.db, customer.id, parsed.data)
      : null;
    if (!order) throw notFound();
    return order;
  }

  /** PR12, rule C2: one code of the customer's own shop order, its reveal logged; 30 / 10 min. */
  async reveal(
    customer: ShopCustomerIdentity,
    number: string,
    codeId: string,
    meta: RequestMeta,
  ): Promise<RevealedCode> {
    if (!isUuid(codeId)) throw notFound();
    const order = await this.order(customer, number);
    const allowed = await withinLimits(this.db, [
      { key: `reveal:shop-customer:${customer.id}`, max: 30, windowMs: TEN_MINUTES },
    ]);
    if (!allowed) throw rateLimited();
    const revealed = await this.db.transaction((tx) =>
      revealCode(tx, this.codesKey, {
        orderId: order.id,
        codeId,
        customerId: null,
        shopCustomerId: customer.id,
        actor: 'customer',
        actorId: customer.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      }),
    );
    if (!revealed) throw notFound();
    return { code: revealed.code, firstRevealedAt: revealed.firstRevealedAt.toISOString() };
  }

  /** `POST /api/shops/:slug/player-checks` (PR5): the shop's quota and the customer's. */
  async playerCheck(
    customer: ShopCustomerIdentity,
    request: PlayerCheckRequest,
    meta: RequestMeta,
  ): Promise<PlayerCheck> {
    if (customer.frozen) throw new CodedException(403, 'ACCOUNT_FROZEN', 'The account is frozen');
    const [shop] = await this.db
      .select({ merchantId: merchantShops.merchantId, status: merchantShops.status })
      .from(merchantShops)
      .where(eq(merchantShops.id, customer.shopId));
    if (!shop || (shop.status !== 'active' && shop.status !== 'closed')) {
      throw new CodedException(403, 'SHOP_UNAVAILABLE', 'The shop sells nothing now');
    }
    const isTest = await this.accounts.isTestCustomer(shop.merchantId);
    return this.playerChecks.checkForShopCustomer(
      { id: customer.id, shopId: customer.shopId, merchantId: shop.merchantId, isTest },
      request,
      meta,
    );
  }

  /** `POST /api/admin/orders/:id/shop-compensation` (PR10). */
  async compensate(
    orderId: string,
    body: ShopCompensationRequest,
    idempotencyKey: string,
    adminId: string,
    meta: RequestMeta,
  ): Promise<{ compensation: ShopCompensation; replayed: boolean }> {
    if (!isUuid(orderId)) throw notFound();
    try {
      const { compensation, replayed } = await this.db.transaction((tx) =>
        compensateShopOrder(tx, this.jobs, {
          orderId,
          units: body.units,
          marginFrom: body.marginFrom,
          reason: body.reason,
          idempotencyKey,
          adminId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        }),
      );
      return {
        compensation: {
          id: compensation.id,
          orderId: compensation.orderId,
          units: compensation.units,
          vertexUsdUnits: compensation.vertexUsdUnits,
          marginUsdUnits: compensation.marginUsdUnits,
          marginFrom: compensation.marginFrom,
          createdAt: compensation.createdAt.toISOString(),
        },
        replayed,
      };
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }

  /** `GET /api/merchant/shop/orders` (PR9): the shop's orders with their margins. */
  async merchantOrders(
    merchantId: string,
    query: MerchantShopOrderQuery,
  ): Promise<MerchantShopOrderPage> {
    const shop = await this.merchants.readableShop(merchantId);
    const page = await merchantShopOrderPage(this.db, shop.id, {
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
      ...(query.customerId && { shopCustomerId: query.customerId }),
    });
    return {
      items: page.items,
      nextCursor: page.more && page.last ? encodeCursor(page.last) : null,
    };
  }

  /** `GET /api/merchant/shop/stats` (SP3): today, this month or the last 30 Damascus days. */
  async stats(merchantId: string, query: ShopStatsQuery, now = new Date()): Promise<ShopStats> {
    const shop = await this.merchants.readableShop(merchantId);
    const to = zoneDate(now);
    const from =
      query.period === 'today'
        ? to
        : query.period === 'month'
          ? zoneDate(zoneMonthStart(zoneYearMonth(now).year, zoneYearMonth(now).month))
          : zoneDate(zoneDayStart(now, 29));
    const { days, activeCustomers } = await shopStatsDays(this.db, shop.id, from, to);
    const sum = (key: Exclude<keyof (typeof days)[number], 'date'>) =>
      days.reduce((total, day) => total + day[key], 0);
    return {
      period: query.period,
      from,
      to,
      totals: {
        visits: sum('visits'),
        signUps: sum('signUps'),
        activeCustomers,
        orders: sum('orders'),
        salesUsdUnits: sum('salesUsdUnits'),
        marginReleasedUsdUnits: sum('marginReleasedUsdUnits'),
        transfersUsdUnits: sum('transfersUsdUnits'),
        returnsUsdUnits: sum('returnsUsdUnits'),
      },
      days,
    };
  }

  /** `GET /api/merchant/shop/sticker.png` (SP2): 20 an hour per merchant. */
  async sticker(merchantId: string, size: ShopStickerSize): Promise<Buffer> {
    const shop = await this.merchants.readableShop(merchantId);
    if (shop.status !== 'active' && shop.status !== 'suspended') {
      throw new CodedException(409, 'SHOP_STATE_INVALID', 'The shop has no sticker now', {
        status: shop.status,
      });
    }
    const allowed = await withinLimits(this.db, [
      { key: `shop-sticker:${merchantId}`, max: SHOP_STICKERS_PER_HOUR, windowMs: HOUR },
    ]);
    if (!allowed) throw rateLimited();
    return renderShopSticker({
      name: shop.displayName,
      brandColor: shop.brandColor,
      url: `${this.env.STORE_URL}/s/${shop.slug}`,
      logo: await this.logo(merchantId),
      size,
    });
  }

  /** ST2: the merchant's receipt logo, or null for the letter mark. */
  private async logo(merchantId: string): Promise<Buffer | null> {
    const brand = await receiptSettingsOf(this.db, merchantId);
    const file = brand?.logoFileId
      ? await this.files.serve(brand.logoFileId, 'merchant_logo')
      : null;
    return file ? file.read() : null;
  }
}
