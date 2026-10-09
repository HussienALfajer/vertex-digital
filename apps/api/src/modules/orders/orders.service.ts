import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  Checkout,
  CreatedOrder,
  checkoutRequestSchema,
  createOrderSchema,
  Order,
  OrderListQuery,
  OrderPage,
  RevealedCode,
} from '@vertex-digital/contracts';
import {
  cancelOwnReservation,
  checkoutOrders,
  customerCheckout,
  customerOrder,
  customerOrderPage,
  customerSavedPlayers,
  type Database,
  orderCodesKey,
  type PlayerCheckLookup,
  productRoutingStates,
  purchaseOrder,
  revealCode,
  type Transaction,
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
import { PlayerChecksService } from './player-checks.service.js';

const TEN_MINUTES = 10 * 60 * 1000;

/** A purchase request as the controller parsed it. */
export type PurchaseBody = z.output<typeof createOrderSchema>;

/** A checkout request as the controller parsed it (S10 rule CT5). */
export type CheckoutBody = z.output<typeof checkoutRequestSchema>;

/** S10: a body's save and gift choices, only when sent, so older bodies keep their hash. */
const convenience = (body: Pick<PurchaseBody, 'savePlayer' | 'gift'>) =>
  body.savePlayer || body.gift ? [body.savePlayer ?? null, body.gift ?? null] : [];

const sortedFields = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** The body a key replays (rule O1): the same fields in any order are the same request. */
export function requestHash(body: PurchaseBody) {
  const canonical = JSON.stringify([
    body.productId,
    body.quantity,
    sortedFields(body.fields),
    body.expectedUnitPriceUsdUnits,
    body.whenBalanceShort,
    body.confirmPlayer,
    ...convenience(body),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The body a checkout key replays (S10 rule CT5): every line, in order. */
export function checkoutHash(body: CheckoutBody) {
  const canonical = JSON.stringify(
    body.lines.map((line) => [
      line.productId,
      line.quantity,
      sortedFields(line.fields),
      line.expectedUnitPriceUsdUnits,
      line.confirmPlayer,
      line.savePlayer ?? null,
      line.gift ?? null,
    ]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The customer's orders (S08): the purchase (rules O1–O6) through `purchaseOrder` in
 * `packages/db` under the switches' shared lock, with S09's reservation (RS1, RS2) and player
 * check (PV8), the customer's own list and order, code reveals (rule C2) and the cancel of a
 * reservation (RS8). Every read filters by the customer: another customer's order is not found.
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
    private readonly playerChecks: PlayerChecksService,
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
  ): Promise<{ order: CreatedOrder; created: boolean }> {
    if (channel === 'store') await this.purchaseLimits(customerId, meta);
    try {
      const { order, created, savedPlayer } = await this.db.transaction(async (tx) => {
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
            whenBalanceShort: body.whenBalanceShort,
            confirmPlayer: body.confirmPlayer,
            savePlayer: body.savePlayer,
            gift: body.gift,
            playerCheck: this.playerCheck,
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
      const view = (await customerOrder(
        this.db,
        customerId,
        order.id,
        this.env.STORE_URL,
      )) as Order;
      const [saved] = savedPlayer
        ? await customerSavedPlayers(this.db, customerId, { id: savedPlayer.id })
        : [];
      return { order: { ...view, savedPlayer: saved ?? null }, created };
    } catch (error) {
      throw asCodedException(error);
    }
  }

  /**
   * S10 rules CT5, CT9: one checkout counts once in the purchase limits; `created` is false when
   * the key replayed an earlier checkout of the same body.
   */
  async checkout(
    customerId: string,
    idempotencyKey: string,
    body: CheckoutBody,
    meta: RequestMeta,
    channel: 'store' | 'cli' = 'store',
  ): Promise<{ checkout: Checkout; created: boolean }> {
    if (channel === 'store') await this.purchaseLimits(customerId, meta);
    try {
      const { checkout, created } = await this.db.transaction(async (tx) => {
        const switches = await this.settings.valuesForCreation(tx);
        return checkoutOrders(
          tx,
          { jobs: this.jobs, now: new Date() },
          {
            customerId,
            lines: body.lines,
            playerCheck: this.playerCheck,
            idempotencyKey,
            requestHash: checkoutHash(body),
            fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
            purchasesStopped: switches.purchases_stopped,
            channel,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
        );
      });
      const view = (await customerCheckout(this.db, customerId, checkout.id)) as NonNullable<
        Awaited<ReturnType<typeof customerCheckout>>
      >;
      return {
        checkout: {
          id: checkout.id,
          totalUsdUnits: checkout.totalUsdUnits,
          totalSypUnits: checkout.totalSypUnits,
          orders: view.items,
        },
        created,
      };
    } catch (error) {
      throw asCodedException(error);
    }
  }

  /** S08 rule O1's limits: 10 purchases per 10 minutes per customer, 30 per address. */
  private async purchaseLimits(customerId: string, meta: RequestMeta) {
    const allowed = await withinLimits(this.db, [
      { key: `order:customer:${customerId}`, max: 10, windowMs: TEN_MINUTES },
      { key: `order:ip:${meta.ipAddress ?? 'unknown'}`, max: 30, windowMs: TEN_MINUTES },
    ]);
    if (!allowed) throw orderRefusals.rateLimited();
  }

  /** S09 rule PV8: the cached check of an order's fields. */
  private readonly playerCheck = (
    tx: Transaction,
    order: Parameters<PlayerChecksService['lookup']>[1],
  ): Promise<PlayerCheckLookup | null> => this.playerChecks.lookup(tx, order);

  /** Rule RS8: the customer cancels an own reservation. */
  async cancel(customerId: string, orderId: string, meta: RequestMeta): Promise<Order> {
    if (!isUuid(orderId)) throw orderRefusals.notFound();
    try {
      await this.db.transaction((tx) =>
        cancelOwnReservation(
          tx,
          { jobs: this.jobs },
          { orderId, customerId, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
        ),
      );
    } catch (error) {
      throw asCodedException(error);
    }
    return (await customerOrder(this.db, customerId, orderId, this.env.STORE_URL)) as Order;
  }

  /**
   * `order:place` (development): buys for the customer with this email at the product's current
   * price, through `purchase` with the channel `cli`; `reserve` and `confirmPlayer` as the buy box
   * sends them (S09).
   */
  async placeForCli(input: {
    email: string;
    productId: string;
    quantity: number;
    fields: Record<string, string>;
    reserve?: boolean;
    confirmPlayer?: boolean;
    /** S10: `--save <label>`, `--gift-sender`, `--gift-message`. */
    saveLabel?: string;
    gift?: { senderName?: string; message?: string };
  }): Promise<CreatedOrder> {
    const customerId = await this.cliCustomer(input.email);
    const { order } = await this.purchase(
      customerId,
      randomUUID(),
      {
        productId: input.productId,
        quantity: input.quantity,
        fields: input.fields,
        expectedUnitPriceUsdUnits: await this.cliPrice(input.productId),
        whenBalanceShort: input.reserve ? 'reserve' : 'refuse',
        confirmPlayer: input.confirmPlayer ?? false,
        ...(input.saveLabel && { savePlayer: { label: input.saveLabel } }),
        ...(input.gift && { gift: input.gift }),
      },
      { ipAddress: null, userAgent: 'order:place' },
      'cli',
    );
    return order;
  }

  /**
   * `checkout:place` (S10, development): pays these lines for the customer with this email at
   * each product's current price, the player ids confirmed.
   */
  async checkoutForCli(input: {
    email: string;
    lines: { productId: string; quantity: number; fields: Record<string, string> }[];
  }): Promise<Checkout> {
    const customerId = await this.cliCustomer(input.email);
    const lines = [];
    for (const line of input.lines) {
      lines.push({
        ...line,
        expectedUnitPriceUsdUnits: await this.cliPrice(line.productId),
        confirmPlayer: true,
      });
    }
    const { checkout } = await this.checkout(
      customerId,
      randomUUID(),
      { lines },
      { ipAddress: null, userAgent: 'checkout:place' },
      'cli',
    );
    return checkout;
  }

  private async cliCustomer(email: string): Promise<string> {
    const customerId = await this.customers.customerIdByEmail(email);
    if (!customerId) throw orderRefusals.notFound();
    return customerId;
  }

  /** The product's current price, for the development CLIs. */
  private async cliPrice(productId: string): Promise<number> {
    const state = isUuid(productId)
      ? (await productRoutingStates(this.db, [productId], routingContext(this.env))).get(productId)
      : undefined;
    if (!state) throw orderRefusals.notFound();
    return state.current?.priceUsdUnits ?? 0;
  }

  async list(customerId: string, query: OrderListQuery): Promise<OrderPage> {
    if (query.checkout) {
      const checkout = await customerCheckout(this.db, customerId, query.checkout);
      if (!checkout) throw orderRefusals.notFound();
      return { items: checkout.items, nextCursor: null, checkout: checkout.checkout };
    }
    const page = await customerOrderPage(this.db, customerId, {
      after: query.cursor ? decodeCursor(query.cursor) : null,
      limit: query.limit,
    });
    return {
      items: page.items,
      nextCursor: page.more && page.last ? encodeCursor(page.last) : null,
      checkout: null,
    };
  }

  async order(customerId: string, orderId: string): Promise<Order> {
    const order = isUuid(orderId)
      ? await customerOrder(this.db, customerId, orderId, this.env.STORE_URL)
      : null;
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
