import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorQuery,
  ReturnRequest,
  ShopCustomerProfile,
  ShopWallet,
  ShopWalletEntryPage,
} from '@vertex-digital/contracts';
import {
  type Database,
  endShopReturn,
  merchantShops,
  shopCustomerBalances,
  shopCustomers,
  shopRateNow,
  shopReturnRequests,
  shopWalletEntries,
} from '@vertex-digital/db';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import type { ShopCustomerIdentity } from './shop-auth.service.js';
import { shopErrorToHttp } from './shop-errors.js';
import { returnRequestOf } from './shops-merchant.service.js';

const notFound = (what: string) => new CodedException(404, 'NOT_FOUND', `No such ${what}`);

/**
 * A shop customer's own account in the shop (S26): the profile, the wallet with its pending
 * return request and timeline, and the answer to a return request (WL5, WL6). Every read is the
 * customer's own, in the path's shop.
 */
@Injectable()
export class ShopCustomersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jobs: JobsService,
  ) {}

  /** `GET /api/shops/:slug/me`. */
  async profile(customer: ShopCustomerIdentity): Promise<ShopCustomerProfile> {
    const [row] = await this.db
      .select()
      .from(shopCustomers)
      .where(and(eq(shopCustomers.id, customer.id), eq(shopCustomers.shopId, customer.shopId)));
    if (!row) throw notFound('account');
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      frozen: row.frozenAt !== null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** `GET /api/shops/:slug/wallet`: the balance, the shop's rate and a pending request. */
  async wallet(customer: ShopCustomerIdentity): Promise<ShopWallet> {
    const [shop] = await this.db
      .select({ id: merchantShops.id, rateMode: merchantShops.rateMode })
      .from(merchantShops)
      .where(eq(merchantShops.id, customer.shopId));
    if (!shop) throw notFound('shop');
    const balances = await shopCustomerBalances(this.db, [customer.id]);
    const { rate } = await shopRateNow(this.db, shop);
    const [pending] = await this.db
      .select()
      .from(shopReturnRequests)
      .where(
        and(
          eq(shopReturnRequests.shopCustomerId, customer.id),
          eq(shopReturnRequests.status, 'pending'),
        ),
      );
    return {
      balanceUsdUnits: balances.get(customer.id) ?? 0,
      rate,
      pendingReturn: pending ? returnRequestOf(pending) : null,
    };
  }

  /** `GET /api/shops/:slug/wallet/entries`: newest first, the cursor a write position. */
  async entries(customer: ShopCustomerIdentity, query: CursorQuery): Promise<ShopWalletEntryPage> {
    const before = query.cursor ? Number.parseInt(query.cursor, 10) : null;
    if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) {
      throw new CodedException(400, 'VALIDATION_FAILED', 'Invalid cursor', [
        { path: ['cursor'], message: 'Invalid cursor' },
      ]);
    }
    const rows = await shopWalletEntries(this.db, customer.id, query.limit + 1, before);
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map(({ position: _, createdAt, ...row }) => ({
        ...row,
        createdAt: createdAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit && last ? String(last.position) : null,
    };
  }

  /** `POST /api/shops/:slug/return-requests/:id/confirm` or `/decline` (WL5, WL6). */
  async answerReturn(
    customer: ShopCustomerIdentity,
    requestId: string,
    answer: { action: 'confirm'; idempotencyKey: string } | { action: 'decline' },
    meta: RequestMeta,
  ): Promise<{ request: ReturnRequest; replayed: boolean }> {
    const [request] = await this.db
      .select({ shopCustomerId: shopReturnRequests.shopCustomerId })
      .from(shopReturnRequests)
      .where(eq(shopReturnRequests.id, requestId));
    if (request?.shopCustomerId !== customer.id) throw notFound('return request');
    try {
      const ended = await this.db.transaction((tx) =>
        endShopReturn(
          tx,
          this.jobs,
          requestId,
          answer.action === 'confirm'
            ? {
                action: 'confirm',
                shopCustomerId: customer.id,
                idempotencyKey: answer.idempotencyKey,
              }
            : { action: 'decline', shopCustomerId: customer.id },
          { kind: 'shop_customer', id: customer.id, channel: 'store', ...meta },
        ),
      );
      return { request: returnRequestOf(ended.request), replayed: ended.replayed };
    } catch (error) {
      throw shopErrorToHttp(error);
    }
  }
}
