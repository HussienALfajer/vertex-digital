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
});

/** One product of `GET /products`. */
export const productSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  category: z.string().nullish(),
  brand: z.string().nullish(),
  /** `voucher`, `topup` or `manual` (fulfilled by hand at WDG). */
  type: z.string(),
  price: decimalSchema,
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

/** `POST /products/{id}/purchase`: 201 for a new order, 200 for a replay of its key. */
export const purchaseReplySchema = z.object({
  success: z.literal(true),
  data: z.object({
    order_id: z.number().int().positive(),
    status: z.string().min(1),
    delivery_items: z.array(z.string()).nullish(),
  }),
});

/** `GET /orders/{id}/delivery` with 200 (ready). Its body is not documented: see the doc. */
export const deliveryReplySchema = z.object({
  success: z.literal(true),
  data: z.object({
    delivery_items: z.array(z.string()).nullish(),
    quantity: z.number().int().positive().optional(),
  }),
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
    delivery_items: z.array(z.string()).nullish(),
    refunded: z.boolean().optional(),
  }),
});
