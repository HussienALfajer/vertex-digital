import { z } from 'zod';

/*
 * WDGZone replies (docs/suppliers/wdgzone.md). Every reply is an envelope: `success: true` with
 * `data`, or `success: false` with `error: { code, message }`. Extra fields are tolerated; a
 * missing required one fails parsing, so the reply is never trusted.
 */

/** Amounts come as JSON numbers with up to 3 decimals (`10.475`); a decimal string is read too. */
const decimalSchema = z.union([z.number(), z.string()]);

export const errorReplySchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().optional() }),
});

/** `GET /me`: the reseller and its wallet. */
export const meReplySchema = z.object({
  success: z.literal(true),
  data: z.object({ balance: decimalSchema, currency: z.string() }),
});

const requiredFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().nullish(),
  type: z.string().nullish(),
  /** A `select` field's choices. */
  options: z
    .array(z.object({ label: z.string().nullish(), value: z.union([z.string(), z.number()]) }))
    .nullish(),
});

/** One product of `GET /products`. */
export const productSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  category_id: z.number().int().positive().nullish(),
  category: z.string().nullish(),
  brand: z.string().nullish(),
  /** `voucher`, `topup` or `manual` (fulfilled by hand at WDG). */
  type: z.string(),
  price: decimalSchema,
  /** The price before WDG's discount (S16 SF1). */
  original_price: decimalSchema.nullish(),
  currency: z.string(),
  stock: z.number().int().nullish(),
  available: z.boolean(),
  requires_player_id: z.boolean(),
  required_fields: z.array(requiredFieldSchema).nullish(),
});

export type WdgProduct = z.infer<typeof productSchema>;

/** `GET /products`: one page; each product is parsed on its own (a bad one is skipped). */
export const productsPageSchema = z.object({
  success: z.literal(true),
  data: z.array(z.unknown()),
  pagination: z.object({
    page: z.number().int().positive(),
    total_pages: z.number().int().nonnegative(),
  }),
});

/**
 * A delivered item (S16 MF4, WDG support 2026-10-13): a plain code, or `{ code, pin }`. Read on
 * the purchase reply, the poll and the webhook alike.
 */
export const deliveryItemSchema = z.union([
  z.string(),
  z.object({
    code: z.union([z.string(), z.number()]).transform(String),
    pin: z.union([z.string(), z.number()]).transform(String).nullish(),
  }),
]);

export type WdgDeliveryItem = z.infer<typeof deliveryItemSchema>;

/** `POST /products/{id}/purchase`: 201 for a new order, 200 for a replay of its key. */
export const purchaseReplySchema = z.object({
  success: z.literal(true),
  data: z.object({
    order_id: z.number().int().positive(),
    status: z.string().min(1),
    delivery_items: z.array(deliveryItemSchema).nullish(),
  }),
});

/**
 * `GET /orders/{id}/delivery` with 200 (ready): `{ data: { order_id, status: "COMPLETED",
 * delivery_items: [{ code, pin }] } }` (WDG support, 2026-10-13).
 */
export const deliveryReplySchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.string().nullish(),
    delivery_items: z.array(deliveryItemSchema).nullish(),
    quantity: z.number().int().positive().optional(),
  }),
});

/** `GET /orders/{id}/delivery` with 410: `{ data: { status, refunded: true } }`, no `error`. */
export const refundedReplySchema = z.object({
  data: z.object({ status: z.string().min(1).max(64) }),
});

/**
 * `GET /orders/{id}` (S16 MF4), read after a poll's 202 for its `status` only: `pending`,
 * `processing`, `completed`, `refunded`, `failed`, `cancelled`. The rest is not documented.
 */
export const orderStateReplySchema = z.object({
  success: z.literal(true),
  data: z.object({ status: z.string().min(1).max(64) }),
});

export const WDG_WEBHOOK_EVENTS = ['order.completed', 'order.failed', 'order.refunded'] as const;

/** The signed time of a webhook, read before the rest of its body is trusted. */
export const webhookTimeSchema = z.object({ created_at: z.string().min(1) });

/** A webhook body (`X-WDG-Event-ID` is the same `id`). */
export const webhookBodySchema = z.object({
  id: z.string().min(1).max(128),
  event: z.enum(WDG_WEBHOOK_EVENTS),
  created_at: z.string().min(1),
  data: z.object({
    order_id: z.number().int().positive(),
    quantity: z.number().int().positive(),
    delivery_items: z.array(deliveryItemSchema).nullish(),
    refunded: z.boolean().optional(),
  }),
});

/**
 * `GET /categories` (S16 SC1): the documented example is one array; a `pagination` object, if
 * WDG sends one, is followed page by page. Each node is parsed on its own.
 */
export const categoriesReplySchema = z.object({
  success: z.literal(true),
  data: z.array(z.unknown()),
  pagination: z
    .object({
      page: z.number().int().positive(),
      total_pages: z.number().int().nonnegative(),
    })
    .nullish(),
});

/** One category node (docs: `id`, `parent_id`, `name`, `type`, counts, `image_url`). */
export const categorySchema = z.object({
  id: z.number().int().positive(),
  parent_id: z.number().int().positive().nullish(),
  name: z.string().min(1),
  type: z.string().nullish(),
  product_count: z.number().int().nonnegative().nullish(),
  in_stock_products: z.number().int().nonnegative().nullish(),
  image_url: z.string().nullish(),
});

export type WdgCategory = z.infer<typeof categorySchema>;

/**
 * `GET /transactions` and `GET /orders` (S16 SF3): paged lists whose rows WDG does not document.
 * Each row is read leniently on its own; what it does not carry is left out (docs, "Open
 * questions"). The page ends the list when `pagination` says so, else when it is short.
 */
export const statementReplySchema = z.object({
  success: z.literal(true),
  data: z.array(z.unknown()),
  pagination: z
    .object({
      page: z.number().int().positive(),
      total_pages: z.number().int().nonnegative(),
    })
    .nullish(),
});

const text = z.union([z.string(), z.number()]).transform(String);

export const transactionRowSchema = z.object({
  id: text,
  type: z.string().nullish(),
  amount: decimalSchema.nullish(),
  balance_after: decimalSchema.nullish(),
  reference: z.string().nullish(),
  description: z.string().nullish(),
  order_id: text.nullish(),
  // Seen live on 2026-10-19 (F11-9): a purchase names its order as `reference_type: "order"`.
  reference_type: z.string().nullish(),
  reference_id: text.nullish(),
  currency: z.string().nullish(),
  created_at: z.string().nullish(),
});

export const orderRowSchema = z.object({
  id: text,
  product_id: text.nullish(),
  product_name: z.string().nullish(),
  product: z.string().nullish(),
  quantity: z.number().int().positive().nullish(),
  status: z.string().nullish(),
  total: decimalSchema.nullish(),
  // Seen live on 2026-10-19 (F11-9): the amount is `total_price`, a decimal string.
  total_price: decimalSchema.nullish(),
  currency: z.string().nullish(),
  created_at: z.string().nullish(),
});

/**
 * `GET /health` (with the key: it answers 401 without one, seen 2026-10-13): `{ status,
 * catalog_updated_at, time }`, at the top or in `data`.
 */
const healthBodySchema = z.object({
  status: z.string().min(1).max(64),
  catalog_updated_at: z.string().nullish(),
});

export const healthReplySchema = z.union([
  healthBodySchema,
  z.object({ data: healthBodySchema }).transform((reply) => reply.data),
]);
