import { z } from 'zod';
import {
  catalogImageSchema,
  gameServiceStatusSchema,
  storeFieldSchema,
  storeProductSchema,
  storeServiceStateSchema,
} from './catalog.js';
import { serviceClassSchema } from './credit.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { markupPrice, type SellingPriceInput, type SellingSettings } from './merchant-tools.js';
import {
  CURRENCY_SCALE,
  ceilToStep,
  sypToUsd,
  USD_CENT,
  usdCentsSchema,
  usdToSyp,
} from './money.js';
import { createOrderSchema, orderSchema, orderSummarySchema, orderTotal } from './orders.js';
import { shopStatusSchema, shopSuspendReasonSchema } from './shops.js';
import { ticketSchema, ticketSummarySchema } from './support.js';

/*
 * Selling in a merchant's shop (S26 PR1–PR12, TK1–TK5, SP1–SP3, ADR 0040), owned by the api `shops`
 * module: the shop's public catalog at the merchant's selling prices, the shop customer's purchase,
 * the margin held until the order finishes, a compensation after delivery, the shop's tickets and
 * statistics. A shop response never carries the merchant's purchase price, the margin, the list's
 * name or Vertex's retail price (PR4).
 */

const USD = CURRENCY_SCALE.USD;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// --- Selling prices (PR2, PR3, ST4) ---

/**
 * PR2: a pack's unit selling price in USD: the merchant's own USD price; an own SYP price ÷ the
 * shop's rate, rounded **up** to whole cents (null without a rate: not sold, edge case 9); else the
 * purchase price × (1 + markup), rounded up to whole cents; else the purchase price itself.
 */
export function shopSellingPrice(
  buyUsdUnits: number,
  settings: SellingSettings,
  ownPrice: SellingPriceInput | null,
  rate: string | null,
): number | null {
  if (ownPrice?.currency === 'usd') return ownPrice.amountUnits;
  if (ownPrice?.currency === 'syp') {
    if (rate === null) return null;
    return ceilToStep(sypToUsd(ownPrice.amountUnits, rate, 'up'), USD_CENT);
  }
  if (settings.markupBp !== null) return markupPrice(buyUsdUnits, settings.markupBp);
  return buyUsdUnits;
}

/**
 * ST4: the SYP a shop shows for a unit selling price: an own SYP price as set; else USD × the
 * shop's rate rounded up to the merchant's step (the store's by default); null without a rate.
 */
export function shopSellingSyp(
  sellUsdUnits: number,
  ownPrice: SellingPriceInput | null,
  rate: string | null,
  stepUnits: number,
): number | null {
  if (ownPrice?.currency === 'syp') return ownPrice.amountUnits;
  if (rate === null) return null;
  return ceilToStep(usdToSyp(sellUsdUnits, rate, 'up'), stepUnits);
}

/** PR3: the margin guard: a pack is sold in the shop only at or above its purchase price. */
export function shopPackSellable(sellUsdUnits: number | null, buyUsdUnits: number): boolean {
  return sellUsdUnits !== null && sellUsdUnits >= buyUsdUnits;
}

/** What `units` of a shop order move (PR6, PR8, PR10): selling, buying and margin, in USD units. */
export interface ShopOrderAmounts {
  sellUsdUnits: number;
  buyUsdUnits: number;
  marginUsdUnits: number;
}

/** PR6, PR8: S = sell × units, B = buy × units, margin = S − B (never negative, PR3). */
export function shopOrderAmounts(
  unitSellUsdUnits: number,
  unitBuyUsdUnits: number,
  units: number,
): ShopOrderAmounts {
  if (unitSellUsdUnits < unitBuyUsdUnits) throw new RangeError('A shop pack is sold below cost');
  const sellUsdUnits = orderTotal(unitSellUsdUnits, units);
  const buyUsdUnits = orderTotal(unitBuyUsdUnits, units);
  return { sellUsdUnits, buyUsdUnits, marginUsdUnits: sellUsdUnits - buyUsdUnits };
}

// --- Compensation (PR10) ---

/** PR10, Q10: a delivered shop order is compensated within 7 days of its finish. */
export const SHOP_COMPENSATION_WINDOW_DAYS = 7;

/**
 * PR10: who pays the margin part of a compensation: the merchant's wallet, the store as an
 * adjustment, or nobody (Vertex's part only; the shop ticket tells the merchant what is owed).
 */
export const SHOP_COMPENSATION_MARGIN_SOURCES = ['merchant', 'store', 'none'] as const;

export const shopCompensationMarginSourceSchema = z
  .enum(SHOP_COMPENSATION_MARGIN_SOURCES)
  .meta({ id: 'ShopCompensationMarginSource' });

export type ShopCompensationMarginSource = z.infer<typeof shopCompensationMarginSourceSchema>;

/** Why `ORDER_NOT_COMPENSABLE` refuses (its `details.reason`). */
export type ShopCompensationRefusal = 'not_shop_order' | 'not_finished' | 'window_closed' | 'units';

/**
 * PR10: why `units` of an order cannot be compensated now, or null: a shop order, finished with
 * delivered units, within 7 days of its finish, and no more units than delivered and not yet
 * compensated.
 */
export function shopCompensationRefusal(
  order: {
    shopOrder: boolean;
    finishedAt: Date | null;
    deliveredQuantity: number;
    compensatedQuantity: number;
  },
  units: number,
  now: Date,
): ShopCompensationRefusal | null {
  if (!order.shopOrder) return 'not_shop_order';
  if (order.finishedAt === null || order.deliveredQuantity === 0) return 'not_finished';
  if (now.getTime() > order.finishedAt.getTime() + SHOP_COMPENSATION_WINDOW_DAYS * DAY_MS) {
    return 'window_closed';
  }
  if (units > order.deliveredQuantity - order.compensatedQuantity) return 'units';
  return null;
}

/**
 * PR10: the two parts of a compensation of `units`: Vertex's (the purchase price) and the margin,
 * which is owed back only when the order's margin was released (null source: none to post).
 */
export function shopCompensationAmounts(
  unitSellUsdUnits: number,
  unitBuyUsdUnits: number,
  units: number,
  marginReleased: boolean,
): { vertexUsdUnits: number; marginUsdUnits: number } {
  const amounts = shopOrderAmounts(unitSellUsdUnits, unitBuyUsdUnits, units);
  return {
    vertexUsdUnits: amounts.buyUsdUnits,
    marginUsdUnits: marginReleased ? amounts.marginUsdUnits : 0,
  };
}

/** `POST /api/admin/orders/:id/shop-compensation` (PR10). */
export const shopCompensationRequestSchema = z
  .object({
    units: z.int().min(1).max(1_000_000),
    reason: z.string().trim().min(3).max(500),
    /** Ignored when the order's margin was not released (no margin part). */
    marginFrom: shopCompensationMarginSourceSchema,
  })
  .meta({ id: 'ShopCompensationRequest' });

export type ShopCompensationRequest = z.infer<typeof shopCompensationRequestSchema>;

export const shopCompensationSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    units: z.int().positive(),
    vertexUsdUnits: z.int().positive(),
    marginUsdUnits: z.int().nonnegative(),
    marginFrom: shopCompensationMarginSourceSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ShopCompensation' });

export type ShopCompensation = z.infer<typeof shopCompensationSchema>;

// --- Tickets (TK2) ---

/** TK2: the customer may escalate a ticket the merchant left unanswered this long. */
export const SHOP_TICKET_ESCALATION_HOURS = 24;

/**
 * TK2: the customer may ask for the admin when the ticket is open, not escalated, and its last
 * customer message is 24 hours old with no merchant reply after it.
 */
export function shopTicketCustomerMayEscalate(
  ticket: {
    status: string;
    escalatedAt: Date | null;
    lastCustomerMessageAt: Date | null;
    lastMerchantMessageAt: Date | null;
  },
  now: Date,
): boolean {
  if (ticket.status === 'closed' || ticket.escalatedAt !== null) return false;
  const asked = ticket.lastCustomerMessageAt;
  if (asked === null) return false;
  if (ticket.lastMerchantMessageAt !== null && ticket.lastMerchantMessageAt >= asked) return false;
  return now.getTime() - asked.getTime() >= SHOP_TICKET_ESCALATION_HOURS * HOUR_MS;
}

/** TK3: who the shop customer sees as the replier. */
export const SHOP_TICKET_REPLIERS = ['customer', 'shop', 'support'] as const;

export const shopTicketReplierSchema = z
  .enum(SHOP_TICKET_REPLIERS)
  .meta({ id: 'ShopTicketReplier' });

// --- Abuse: the return ratio (spec "Abuse and fraud") ---

/** The alert's window and floor: a shop's returns over 7 days, at least $200 returned. */
export const SHOP_RETURN_ALERT_DAYS = 7;
export const SHOP_RETURN_ALERT_MIN_USD_UNITS = 200 * USD;

/** Returns above half of the transfers over the window, with at least $200 returned. */
export function shopReturnsAlarming(totals: {
  transferredUsdUnits: number;
  returnedUsdUnits: number;
}): boolean {
  return (
    totals.returnedUsdUnits >= SHOP_RETURN_ALERT_MIN_USD_UNITS &&
    totals.returnedUsdUnits * 2 > totals.transferredUsdUnits
  );
}

// --- Statistics (SP3) ---

/** SP3: a visit of a bot, a crawler or a link preview is not counted. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  return /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|headless|lighthouse/i.test(
    userAgent,
  );
}

export const SHOP_STATS_PERIODS = ['today', 'month', 'last_30_days'] as const;

export const shopStatsQuerySchema = z
  .object({ period: z.enum(SHOP_STATS_PERIODS).default('last_30_days') })
  .meta({ id: 'ShopStatsQuery' });

export type ShopStatsQuery = z.infer<typeof shopStatsQuerySchema>;

const statsFigures = {
  visits: z.int().nonnegative(),
  signUps: z.int().nonnegative(),
  /** Customers who bought in the period. */
  activeCustomers: z.int().nonnegative(),
  orders: z.int().nonnegative(),
  /** Delivered units × the selling price. */
  salesUsdUnits: z.int().nonnegative(),
  marginReleasedUsdUnits: z.int().nonnegative(),
  transfersUsdUnits: z.int().nonnegative(),
  returnsUsdUnits: z.int().nonnegative(),
};

/** `GET /api/merchant/shop/stats` (SP3): the period's totals and its Damascus days. */
export const shopStatsSchema = z
  .object({
    period: z.enum(SHOP_STATS_PERIODS),
    from: z.iso.date(),
    to: z.iso.date(),
    totals: z.object(statsFigures),
    days: z.array(
      z.object({ date: z.iso.date(), ...statsFigures }).omit({ activeCustomers: true }),
    ),
  })
  .meta({ id: 'ShopStats' });

export type ShopStats = z.infer<typeof shopStatsSchema>;

// --- The shop's public pages (PR1, PR4, SP1, SP2) ---

/** The shop as its pages show it: the approved name, the logo or letter mark, the brand. */
export const shopPublicSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    /** The logo's URL (ST2), or null for the letter mark. */
    logoUrl: z.string().nullable(),
    /** ST2: the name's first letter, on the brand color, without a logo. */
    letter: z.string(),
    brandColor: z.string(),
    announcement: z.string().nullable(),
    status: shopStatusSchema.extract(['active', 'suspended', 'closed']),
    /** SH6: the category a suspended shop shows, never the admin's note. */
    suspendReason: shopSuspendReasonSchema.nullable(),
    /** ST3: the shop's rate; null shows USD only (edge case 9). */
    rate: z.string().nullable(),
    /** The merchant's WhatsApp when the receipts show it ("top up the gap"). */
    whatsapp: z.string().nullable(),
  })
  .meta({ id: 'ShopPublic' });

export type ShopPublic = z.infer<typeof shopPublicSchema>;

const storefrontCategory = z.object({
  slug: z.string(),
  nameAr: z.string(),
  image: catalogImageSchema.nullable(),
  games: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      nameAr: z.string(),
      nameEn: z.string(),
      cover: catalogImageSchema.nullable(),
      accentColor: z.string().nullable(),
      status: gameServiceStatusSchema,
    }),
  ),
});

/** `GET /api/shops/:slug` (PR1): pinned games first, then the store's categories, hidden left out. */
export const shopStorefrontSchema = z
  .object({
    shop: shopPublicSchema,
    service: storeServiceStateSchema,
    pinned: storefrontCategory.shape.games,
    categories: z.array(storefrontCategory),
  })
  .meta({ id: 'ShopStorefront' });

export type ShopStorefront = z.infer<typeof shopStorefrontSchema>;

/**
 * A pack in the shop (PR2–PR4): the selling price only. `available` is false while the pack is
 * not sold (out of stock, paused, below cost, a SYP price without a rate).
 */
export const shopProductSchema = storeProductSchema
  .pick({
    id: true,
    kind: true,
    nameAr: true,
    gameAmount: true,
    maxQuantity: true,
    minQuantity: true,
    amountUnitAr: true,
    amountStep: true,
    deliveryStats: true,
    playerCheck: true,
    regionAr: true,
    redemptionAr: true,
  })
  .extend({
    available: z.boolean(),
    unitSellUsdUnits: z.int().positive().nullable(),
    unitSellSypUnits: z.int().positive().nullable(),
  })
  .meta({ id: 'ShopProduct' });

export type ShopProduct = z.infer<typeof shopProductSchema>;

/** `GET /api/shops/:slug/games/:game` (PR1–PR4). */
export const shopGameSchema = z
  .object({
    shop: shopPublicSchema,
    game: storefrontCategory.shape.games.element.extend({
      idGuide: catalogImageSchema.nullable(),
      regionNotesAr: z.string().nullable(),
      serviceClass: serviceClassSchema,
    }),
    fields: z.array(storeFieldSchema),
    products: z.array(shopProductSchema),
  })
  .meta({ id: 'ShopGame' });

export type ShopGame = z.infer<typeof shopGameSchema>;

/** An old slug's answer (SH3): the shop's current slug, with `301`. */
export const shopMovedSchema = z.object({ slug: z.string() }).meta({ id: 'ShopMoved' });

/** SP1: the icon sizes the manifest names. */
export const SHOP_ICON_SIZES = [192, 512] as const;

export const shopIconQuerySchema = z
  .object({
    size: z
      .enum(SHOP_ICON_SIZES.map(String) as [string, ...string[]])
      .transform((size) => Number(size) as (typeof SHOP_ICON_SIZES)[number]),
  })
  .meta({ id: 'ShopIconQuery' });

/** `GET /api/shops/:slug/manifest` (SP1): what the store's web manifest is built from. */
export const shopManifestSchema = z
  .object({
    name: z.string(),
    shortName: z.string(),
    brandColor: z.string(),
    slug: z.string(),
    icons: z.array(z.object({ size: z.int().positive(), url: z.string() })),
  })
  .meta({ id: 'ShopManifest' });

export type ShopManifest = z.infer<typeof shopManifestSchema>;

/** SP2: the sticker's sizes: A6 (105 × 148 mm) and an 80 mm receipt printer's roll. */
export const SHOP_STICKER_SIZES = ['a6', '80mm'] as const;

export const shopStickerQuerySchema = z
  .object({ size: z.enum(SHOP_STICKER_SIZES).default('a6') })
  .meta({ id: 'ShopStickerQuery' });

export type ShopStickerSize = (typeof SHOP_STICKER_SIZES)[number];

/** SP2: at most this many stickers an hour per merchant. */
export const SHOP_STICKERS_PER_HOUR = 20;

// --- The purchase and the shop customer's orders (PR5–PR12) ---

/**
 * `POST /api/shops/:slug/orders` (PR5): one pack, its quantity and fields, the unit selling price
 * the page showed, and the player confirmation. No reservation, gift, saved id or quick link.
 */
export const shopPurchaseSchema = createOrderSchema
  .pick({ productId: true, quantity: true, fields: true, confirmPlayer: true })
  .extend({ expectedUnitSellUsdUnits: usdCentsSchema.min(1) })
  .meta({ id: 'ShopPurchase' });

export type ShopPurchase = z.input<typeof shopPurchaseSchema>;

/** PR4: the order as the shop customer sees it, at the selling price; never the purchase price. */
export const shopOrderSchema = orderSchema
  .pick({
    id: true,
    number: true,
    stage: true,
    product: true,
    game: true,
    fields: true,
    quantity: true,
    deliveredQuantity: true,
    refundedQuantity: true,
    refundReason: true,
    recipient: true,
    timeline: true,
    codes: true,
    playerName: true,
    playerRegion: true,
    deliveryStats: true,
    expectedWithinMinutes: true,
    verificationCode: true,
    help: true,
    createdAt: true,
  })
  .extend({
    unitSellUsdUnits: z.int().positive(),
    totalSellUsdUnits: z.int().positive(),
    /** ST4: the SYP shown at purchase, at the shop's rate then; null without one. */
    totalSellSypUnits: z.int().positive().nullable(),
    refundedUsdUnits: z.int().nonnegative(),
    compensatedUsdUnits: z.int().nonnegative(),
  })
  .meta({ id: 'ShopOrder' });

export type ShopOrder = z.infer<typeof shopOrderSchema>;

export const shopOrderSummarySchema = orderSummarySchema
  .pick({
    id: true,
    number: true,
    stage: true,
    productNameAr: true,
    productKind: true,
    amountStep: true,
    amountUnitAr: true,
    game: true,
    quantity: true,
    createdAt: true,
  })
  .extend({
    totalSellUsdUnits: z.int().positive(),
    totalSellSypUnits: z.int().positive().nullable(),
  })
  .meta({ id: 'ShopOrderSummary' });

export type ShopOrderSummary = z.infer<typeof shopOrderSummarySchema>;

export const shopOrderListQuerySchema = cursorQuerySchema
  .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .meta({ id: 'ShopOrderListQuery' });

export type ShopOrderListQuery = z.infer<typeof shopOrderListQuerySchema>;

export const shopOrderPageSchema = cursorPageSchema(shopOrderSummarySchema, 'ShopOrderPage');

export type ShopOrderPage = z.infer<typeof shopOrderPageSchema>;

// --- Tickets as the shop customer and the merchant see them (TK1–TK5) ---

/** A shop ticket's summary: the customer's view with who answered last and its escalation. */
export const shopTicketSummarySchema = ticketSummarySchema
  .omit({ deposit: true, openedBy: true, lastAuthor: true })
  .extend({
    lastReplier: shopTicketReplierSchema,
    escalatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ShopTicketSummary' });

export type ShopTicketSummary = z.infer<typeof shopTicketSummarySchema>;

export const shopTicketPageSchema = cursorPageSchema(shopTicketSummarySchema, 'ShopTicketPage');

export type ShopTicketPage = z.infer<typeof shopTicketPageSchema>;

const shopTicketMessage = ticketSchema.shape.messages.element
  .omit({ author: true })
  .extend({ from: shopTicketReplierSchema });

/** `GET /api/shops/:slug/tickets/:id` (TK3): the thread, the shop or support as the replier. */
export const shopTicketSchema = shopTicketSummarySchema
  .extend({
    canReply: z.boolean(),
    /** TK2: "طلب تدخل الإدارة" is offered. */
    canEscalate: z.boolean(),
    messages: z.array(shopTicketMessage),
  })
  .meta({ id: 'ShopTicket' });

export type ShopTicket = z.infer<typeof shopTicketSchema>;

/** TK4: the merchant's view: the shop customer and the replier's own kind. */
export const merchantShopTicketSummarySchema = shopTicketSummarySchema
  .extend({
    customer: z.object({ id: z.uuid(), name: z.string(), email: z.string(), phone: z.string() }),
    /** The customer wrote last and the merchant has not answered (the queue's first rows). */
    unanswered: z.boolean(),
  })
  .meta({ id: 'MerchantShopTicketSummary' });

export type MerchantShopTicketSummary = z.infer<typeof merchantShopTicketSummarySchema>;

export const merchantShopTicketPageSchema = cursorPageSchema(
  merchantShopTicketSummarySchema,
  'MerchantShopTicketPage',
);

export const merchantShopTicketSchema = merchantShopTicketSummarySchema
  .extend({ canReply: z.boolean(), messages: z.array(shopTicketMessage) })
  .meta({ id: 'MerchantShopTicket' });

export type MerchantShopTicket = z.infer<typeof merchantShopTicketSchema>;

/** `POST /api/merchant/shop/tickets/:id/escalate` (TK2): the merchant's note to the admin. */
export const shopTicketEscalationSchema = z
  .object({ note: z.string().trim().min(3).max(500) })
  .meta({ id: 'ShopTicketEscalation' });

// --- The merchant's shop orders ("طلبات المتجر", PR9) ---

/** Where a shop order's margin stands: held until it finishes, then released (or none). */
export const SHOP_MARGIN_STATES = ['held', 'released', 'none'] as const;

/** A shop order as its merchant sees it: the customer, the selling price and the margin. */
export const merchantShopOrderRowSchema = z
  .object({
    id: z.uuid(),
    number: z.string(),
    stage: orderSchema.shape.stage,
    customer: z.object({ id: z.uuid(), name: z.string() }),
    productNameAr: z.string(),
    gameNameAr: z.string(),
    quantity: z.int().positive(),
    deliveredQuantity: z.int().nonnegative(),
    totalSellUsdUnits: z.int().positive(),
    /** Held: (S − B) × quantity; released: what reached the wallet. */
    marginUsdUnits: z.int().nonnegative(),
    marginState: z.enum(SHOP_MARGIN_STATES),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MerchantShopOrderRow' });

export type MerchantShopOrderRow = z.infer<typeof merchantShopOrderRowSchema>;

export const merchantShopOrderQuerySchema = cursorQuerySchema
  .extend({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    customerId: z.uuid().optional(),
  })
  .meta({ id: 'MerchantShopOrderQuery' });

export type MerchantShopOrderQuery = z.infer<typeof merchantShopOrderQuerySchema>;

export const merchantShopOrderPageSchema = cursorPageSchema(
  merchantShopOrderRowSchema,
  'MerchantShopOrderPage',
);

export type MerchantShopOrderPage = z.infer<typeof merchantShopOrderPageSchema>;
