import {
  type CodeReleasePurpose,
  maskFieldValue,
  type OrderPrint,
  orderTotal,
  type PublicVerification,
  type ReceiptIssuer,
  ROOT_PRICE_LIST_IDS,
  storeOrderHidesPrice,
  verificationStage,
} from '@vertex-digital/contracts';
import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  catalogGames,
  catalogInputFields,
  catalogProducts,
  fulfilmentAttempts,
  merchantOrderSales,
  merchantProfiles,
  merchantReceiptSettings,
  orderCodeReveals,
  orderCodes,
  orders,
} from '../schema/index.js';
import { OrderError } from './errors.js';
import { decryptSecret } from './secrets.js';
import type { OrderRow } from './transition.js';

/*
 * S21 F34, F35: what a receipt, a printed page and the verification page show of an order, and
 * the release of a merchant's codes to print, copy or export. None of it ever shows the price a
 * merchant paid (BR1).
 */

export interface MerchantBranding {
  tradeName: string;
  /** The WhatsApp number when the merchant chose to show it. */
  whatsapp: string | null;
  logoFileId: string | null;
}

/**
 * BR1, VF2: the shop an order was bought for: the customer's merchant profile when the order was
 * placed while they were a merchant, with the receipt settings in force now; null otherwise.
 */
export async function merchantBranding(
  db: Executor,
  order: Pick<OrderRow, 'customerId' | 'createdAt'>,
): Promise<MerchantBranding | null> {
  if (order.customerId === null) return null;
  const [row] = await db
    .select({
      tradeName: merchantProfiles.tradeName,
      showWhatsapp: merchantReceiptSettings.showWhatsapp,
      whatsapp: merchantReceiptSettings.whatsapp,
      logoFileId: merchantReceiptSettings.logoFileId,
    })
    .from(merchantProfiles)
    .leftJoin(
      merchantReceiptSettings,
      eq(merchantReceiptSettings.customerId, merchantProfiles.customerId),
    )
    .where(
      and(
        eq(merchantProfiles.customerId, order.customerId),
        lte(merchantProfiles.grantedAt, order.createdAt),
        or(isNull(merchantProfiles.revokedAt), gt(merchantProfiles.revokedAt, order.createdAt)),
      ),
    );
  if (!row) return null;
  return {
    tradeName: row.tradeName,
    whatsapp: row.showWhatsapp ? row.whatsapp : null,
    logoFileId: row.logoFileId,
  };
}

/** An order's fields as a receipt shows them: masked (rule SH3), a select as its option label. */
export async function shownFields(
  db: Executor,
  order: Pick<OrderRow, 'gameId' | 'fields'>,
  full = false,
): Promise<{ labelAr: string; value: string }[]> {
  const rules = await db
    .select()
    .from(catalogInputFields)
    .where(eq(catalogInputFields.gameId, order.gameId))
    .orderBy(asc(catalogInputFields.sortOrder));
  return fieldLines(rules, order.fields, full);
}

/**
 * The fields in the game's order with their labels, a select's value by its option's label; the
 * others masked unless `full` (S21 ST2: the merchant's own statement).
 */
export function fieldLines(
  rules: readonly Pick<
    typeof catalogInputFields.$inferSelect,
    'key' | 'labelAr' | 'type' | 'options'
  >[],
  fields: Record<string, string>,
  full: boolean,
): { labelAr: string; value: string }[] {
  const keys = rules.map((rule) => rule.key);
  return Object.entries(fields)
    .sort(([a], [b]) => keys.indexOf(a) - keys.indexOf(b))
    .map(([key, value]) => {
      const rule = rules.find((candidate) => candidate.key === key);
      const option = rule?.type === 'select' ? rule.options?.find((o) => o.value === value) : null;
      return {
        labelAr: rule?.labelAr ?? key,
        value: option ? option.labelAr : full ? value : maskFieldValue(value),
      };
    });
}

/** The units a receipt prices: those not refunded. */
const pricedUnits = (order: Pick<OrderRow, 'quantity' | 'refundedQuantity'>) =>
  order.quantity - order.refundedQuantity;

/** BR1: a merchant's selling price for the units not refunded, or null without a sale row. */
export async function sellingPriceOf(
  db: Executor,
  order: Pick<OrderRow, 'id' | 'quantity' | 'refundedQuantity'>,
): Promise<{ currency: 'usd' | 'syp'; unitAmountUnits: number; totalAmountUnits: number } | null> {
  const [sale] = await db
    .select()
    .from(merchantOrderSales)
    .where(eq(merchantOrderSales.orderId, order.id));
  const units = pricedUnits(order);
  if (!sale || units <= 0) return null;
  return {
    currency: sale.currency,
    unitAmountUnits: sale.unitAmountUnits,
    totalAmountUnits: orderTotal(sale.unitAmountUnits, units),
  };
}

const issuerOf = (branding: MerchantBranding | null): ReceiptIssuer =>
  branding ? { kind: 'merchant', tradeName: branding.tradeName } : { kind: 'store' };

/**
 * PR2, BR1 (`GET /api/orders/:id/print`): the customer's order as a printed receipt, or null when
 * it is not theirs. A merchant's order shows the shop and its selling price; a retail order its
 * price, unless the store placed it free (S16 AP11).
 */
export async function orderPrint(
  db: Executor,
  customerId: string,
  orderId: string,
): Promise<OrderPrint | null> {
  const [row] = await db
    .select({ order: orders, product: catalogProducts, gameNameAr: catalogGames.nameAr })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(and(eq(orders.id, orderId), eq(orders.customerId, customerId)));
  if (!row) return null;
  const { order, product } = row;
  const branding = await merchantBranding(db, order);
  const fields = await shownFields(db, order);
  let price: OrderPrint['price'] = null;
  if (branding) {
    const selling = await sellingPriceOf(db, order);
    price = selling && { kind: 'selling', ...selling };
  } else if (
    !storeOrderHidesPrice(order.adminPurpose) &&
    order.priceListId === ROOT_PRICE_LIST_IDS.retail &&
    pricedUnits(order) > 0
  ) {
    price = {
      kind: 'retail',
      currency: 'usd',
      unitAmountUnits: order.unitPriceUsdUnits,
      totalAmountUnits: orderTotal(order.unitPriceUsdUnits, pricedUnits(order)),
    };
  }
  return {
    orderId: order.id,
    orderNumber: order.number,
    stage: verificationStage(order.status),
    createdAt: order.createdAt.toISOString(),
    game: { nameAr: row.gameNameAr },
    product: { nameAr: product.nameAr, kind: product.kind, redemptionAr: product.redemptionAr },
    quantity: order.quantity,
    deliveredQuantity: order.deliveredQuantity,
    fields,
    issuer: issuerOf(branding),
    whatsapp: branding?.whatsapp ?? null,
    logoFileId: branding?.logoFileId ?? null,
    price,
    verificationCode: order.verificationCode,
  };
}

/**
 * VF2, VF3 (`GET /api/verify/:code`): the order's facts by its full code (an indexed lookup), or
 * null. Never a price, a code, a name, an email, a phone, gift text or the customer's identity.
 */
export async function publicVerification(
  db: Executor,
  code: string,
): Promise<PublicVerification | null> {
  const [row] = await db
    .select({
      order: orders,
      productNameAr: catalogProducts.nameAr,
      gameNameAr: catalogGames.nameAr,
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(eq(orders.verificationCode, code));
  if (!row) return null;
  const { order } = row;
  const branding = await merchantBranding(db, order);
  return {
    issuer: issuerOf(branding),
    orderNumber: order.number,
    game: { nameAr: row.gameNameAr },
    product: { nameAr: row.productNameAr },
    quantity: order.quantity,
    deliveredQuantity: order.deliveredQuantity,
    stage: verificationStage(order.status),
    createdAt: order.createdAt.toISOString(),
    deliveredAt:
      order.deliveredQuantity > 0 && order.finishedAt ? order.finishedAt.toISOString() : null,
    fields: await shownFields(db, order),
  };
}

export interface ReleaseInput {
  orderId: string;
  customerId: string;
  purpose: Exclude<CodeReleasePurpose, 'reveal'>;
  /** Default: every delivered code. */
  codeIds?: readonly string[];
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * CR1: the order's delivered codes in clear (all, or the ones named), in delivery order numbered
 * from 1, with one `order_code_reveals` row per code sharing a release id, in the caller's
 * transaction. Null when the order is not the customer's; `CODES_NOT_DELIVERED` when it has no
 * delivered code or names one it does not have.
 */
export async function releaseCodes(
  tx: Transaction,
  codesKey: Buffer,
  input: ReleaseInput,
): Promise<{ order: OrderRow; codes: { id: string; position: number; code: string }[] } | null> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.customerId, input.customerId)));
  if (!order) return null;
  const delivered = (
    await tx
      .select({ code: orderCodes })
      .from(orderCodes)
      .innerJoin(fulfilmentAttempts, eq(fulfilmentAttempts.id, orderCodes.attemptId))
      .where(eq(orderCodes.orderId, order.id))
      .orderBy(asc(fulfilmentAttempts.createdAt), asc(orderCodes.position))
  ).map((row, index) => ({ ...row.code, number: index + 1 }));
  const wanted = input.codeIds ? new Set(input.codeIds) : null;
  const chosen = wanted ? delivered.filter((code) => wanted.has(code.id)) : delivered;
  if (chosen.length === 0 || (wanted && chosen.length !== wanted.size)) {
    throw new OrderError('CODES_NOT_DELIVERED', 'The order has no such delivered code');
  }
  const releaseId = newId();
  await tx.insert(orderCodeReveals).values(
    chosen.map((code) => ({
      id: newId(),
      codeId: code.id,
      orderId: order.id,
      actor: 'customer' as const,
      actorId: input.customerId,
      purpose: input.purpose,
      releaseId,
      ip: input.ipAddress,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    })),
  );
  return {
    order,
    codes: chosen.map((code) => ({
      id: code.id,
      position: code.number,
      code: decryptSecret(codesKey, code.id, code.ciphertext),
    })),
  };
}

/**
 * CR4: the customer's reveals and releases of the order's codes, newest first, each release once
 * with the positions it showed (codes numbered in delivery order from 1).
 */
export async function codeReleaseLog(
  db: Executor,
  orderId: string,
  numbers: ReadonlyMap<string, number>,
): Promise<{ purpose: CodeReleasePurpose; positions: number[]; createdAt: string }[]> {
  if (numbers.size === 0) return [];
  const rows = await db
    .select()
    .from(orderCodeReveals)
    .where(
      and(
        eq(orderCodeReveals.orderId, orderId),
        eq(orderCodeReveals.actor, 'customer'),
        inArray(orderCodeReveals.codeId, [...numbers.keys()]),
      ),
    )
    .orderBy(asc(orderCodeReveals.createdAt));
  const groups = new Map<
    string,
    { purpose: CodeReleasePurpose; positions: number[]; createdAt: Date }
  >();
  for (const row of rows) {
    const key = row.releaseId ?? row.id;
    const group = groups.get(key) ?? {
      purpose: row.purpose,
      positions: [],
      createdAt: row.createdAt,
    };
    group.positions.push(numbers.get(row.codeId) ?? 0);
    groups.set(key, group);
  }
  return [...groups.values()].reverse().map((group) => ({
    purpose: group.purpose,
    positions: group.positions.sort((a, b) => a - b),
    createdAt: group.createdAt.toISOString(),
  }));
}
