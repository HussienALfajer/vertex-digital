import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  createOrderSchema,
  Order,
  OrderListQuery,
  OrderPage,
  RevealedCode,
} from '@vertex-digital/contracts';
import {
  customerOrder,
  customerOrderPage,
  type Database,
  orderCodesKey,
  productRoutingStates,
  purchaseOrder,
  revealCode,
} from '@vertex-digital/db';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { routingContext } from '../../core/config/routing-context.js';
import { DATABASE } from '../../core/database/database.module.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { decodeCursor, encodeCursor } from '../../core/lists/cursor.js';
import { AuthService, withinLimits } from '../auth/index.js';
import { SettingsService } from '../settings/index.js';
import { asCodedException, orderRefusals } from './order-errors.js';

const TEN_MINUTES = 10 * 60 * 1000;

/** A purchase request as the controller parsed it. */
export type PurchaseBody = z.output<typeof createOrderSchema>;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** The body a key replays (rule O1): the same fields in any order are the same request. */
export function requestHash(body: PurchaseBody) {
  const fields = Object.fromEntries(
    Object.entries(body.fields).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify([
    body.productId,
    body.quantity,
    fields,
    body.expectedUnitPriceUsdUnits,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The customer's orders (S08): the purchase (rules O1–O6) through `purchaseOrder` in
 * `packages/db` under the switches' shared lock, the customer's own list and order, and code
 * reveals (rule C2). Every read filters by the customer: another customer's order is not found.
 */
@Injectable()
export class OrdersService {
  private readonly codesKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobsService,
    private readonly settings: SettingsService,
    private readonly customers: AuthService,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET as string);
  }

  /**
   * Rules O1–O6: `created` is false when the key replayed an earlier purchase of the same body.
   * `order:place` (development) passes the channel `cli` and no limits.
   */
  async purchase(
    customerId: string,
    idempotencyKey: string,
    body: PurchaseBody,
    meta: RequestMeta,
    channel: 'store' | 'cli' = 'store',
  ): Promise<{ order: Order; created: boolean }> {
    if (channel === 'store') {
      const allowed = await withinLimits(this.db, [
        { key: `order:customer:${customerId}`, max: 10, windowMs: TEN_MINUTES },
        { key: `order:ip:${meta.ipAddress ?? 'unknown'}`, max: 30, windowMs: TEN_MINUTES },
      ]);
      if (!allowed) throw orderRefusals.rateLimited();
    }
    try {
      const { order, created } = await this.db.transaction(async (tx) => {
        const switches = await this.settings.valuesForCreation(tx);
        return purchaseOrder(
          tx,
          { jobs: this.jobs, now: new Date() },
          {
            customerId,
            productId: body.productId,
            quantity: body.quantity,
            fields: body.fields,
            expectedUnitPriceUsdUnits: body.expectedUnitPriceUsdUnits,
            idempotencyKey,
            requestHash: requestHash(body),
            fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
            purchasesStopped: switches.purchases_stopped,
            channel,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
        );
      });
      return { order: (await customerOrder(this.db, customerId, order.id)) as Order, created };
    } catch (error) {
      throw asCodedException(error);
    }
  }

  /**
   * `order:place` (development, until S09's buy box): buys for the customer with this email at the
   * product's current price, through `purchase` with the channel `cli`.
   */
  async placeForCli(input: {
    email: string;
    productId: string;
    quantity: number;
    fields: Record<string, string>;
  }): Promise<Order> {
    const customerId = await this.customers.customerIdByEmail(input.email);
    if (!customerId) throw orderRefusals.notFound();
    const state = isUuid(input.productId)
      ? (await productRoutingStates(this.db, [input.productId], routingContext(this.env))).get(
          input.productId,
        )
      : undefined;
    if (!state) throw orderRefusals.notFound();
    const { order } = await this.purchase(
      customerId,
      randomUUID(),
      {
        productId: input.productId,
        quantity: input.quantity,
        fields: input.fields,
        expectedUnitPriceUsdUnits: state.current?.priceUsdUnits ?? 0,
      },
      { ipAddress: null, userAgent: 'order:place' },
      'cli',
    );
    return order;
  }

  async list(customerId: string, query: OrderListQuery): Promise<OrderPage> {
    const page = await customerOrderPage(this.db, customerId, {
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    return {
      items: page.items,
      nextCursor: page.more && page.last ? encodeCursor(page.last) : null,
    };
  }

  async order(customerId: string, orderId: string): Promise<Order> {
    const order = isUuid(orderId) ? await customerOrder(this.db, customerId, orderId) : null;
    if (!order) throw orderRefusals.notFound();
    return order;
  }

  /** Rule C2: the code, its reveal logged; 30 reveals per 10 minutes per customer. */
  async reveal(
    customerId: string,
    orderId: string,
    codeId: string,
    meta: RequestMeta,
  ): Promise<RevealedCode> {
    if (!isUuid(orderId) || !isUuid(codeId)) throw orderRefusals.notFound();
    const allowed = await withinLimits(this.db, [
      { key: `reveal:customer:${customerId}`, max: 30, windowMs: TEN_MINUTES },
    ]);
    if (!allowed) throw orderRefusals.rateLimited();
    const revealed = await this.db.transaction((tx) =>
      revealCode(tx, this.codesKey, {
        orderId,
        codeId,
        customerId,
        actor: 'customer',
        actorId: customerId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      }),
    );
    if (!revealed) throw orderRefusals.notFound();
    return { code: revealed.code, firstRevealedAt: revealed.firstRevealedAt.toISOString() };
  }
}
