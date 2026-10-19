import { z } from 'zod';

/*
 * FazerCards' replies (docs/suppliers/fazercards.md), as read from the live API on 2026-10-20
 * (catalog, account, webhook settings, player check) and from its OpenAPI document and SDK (orders,
 * statement, webhook bodies: the account had no order yet). Lists are read item by item, so one
 * unreadable row never hides the others.
 */

/** `{ ok: false, error, code? }`. */
export const errorReplySchema = z.object({
  ok: z.literal(false).optional(),
  error: z.string().optional(),
  code: z.string().max(64).optional(),
});

/** Amounts are decimal strings with 4 decimals (`"0.8750"`); a number is read too. */
const amount = z.union([z.string().max(32), z.number()]);

const cursorMeta = z.object({
  next_cursor: z.string().max(2_000).nullish(),
  has_more: z.boolean().nullish(),
});

/** `GET /topups`, `GET /giftcards`: one page of categories. */
export const categoriesPageSchema = z.object({
  items: z.array(z.unknown()),
  meta: cursorMeta.nullish(),
});

export const categorySchema = z.object({
  category_id: z.string().min(1).max(128),
  name: z.string().min(1).max(500),
  note: z.string().max(5_000).nullish(),
  imageurl: z.string().max(2_000).nullish(),
  icon_url: z.string().max(2_000).nullish(),
});

export type FzrCategory = z.infer<typeof categorySchema>;

export const fieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().max(200).nullish(),
  type: z.string().max(32).nullish(),
  options: z
    .array(
      z.object({ label: z.string().max(200).nullish(), value: z.union([z.string(), z.number()]) }),
    )
    .nullish(),
});

export type FzrField = z.infer<typeof fieldSchema>;

/** `GET /topups/offers?category_id=`. */
export const topupOffersReplySchema = z.object({
  category_id: z.string().max(128),
  name: z.string().max(500).nullish(),
  offers: z.array(z.unknown()),
  fields: z.array(z.unknown()).nullish(),
  note: z.string().max(5_000).nullish(),
});

export const topupOfferSchema = z.object({
  offer_id: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  price_usd: amount,
});

/** `GET /giftcards/cards?category_id=`: the cards are under `offers`. */
export const giftCardsReplySchema = z.object({
  category_id: z.string().max(128),
  name: z.string().max(500).nullish(),
  offers: z.array(z.unknown()),
});

export const giftCardSchema = z.object({
  card_id: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  price_usd: amount,
  stock: z.int().nullish(),
  min_order_quantity: z.int().nullish(),
  max_order_quantity: z.int().nullish(),
});

/** `GET /balance`. */
export const balanceReplySchema = z.object({ balance: amount, currency: z.string() });

/** `GET /me`: the plan; the login and email are not read. */
export const meReplySchema = z.object({
  plan: z.string().min(1).max(32),
  planExpiresAt: z.string().max(64).nullish(),
  planAutoRenew: z.boolean().nullish(),
  subscriptionActive: z.boolean(),
});

/** A delivered card: a text, or a code with a pin or serial. */
const cardSchema = z.union([
  z.string(),
  z.object({
    code: z.string(),
    pin: z.string().nullish(),
    serial: z.string().nullish(),
  }),
]);

export type FzrCard = z.infer<typeof cardSchema>;

export const orderSchema = z.object({
  id: z.string().regex(/^ord-\d{1,18}$/),
  kind: z.string().max(32).nullish(),
  status: z.string().min(1).max(32),
  quantity: z.int().nullish(),
  total_usd: amount.nullish(),
  cards: z.array(cardSchema).nullish(),
  fail_reason: z.string().max(2_000).nullish(),
});

/** `POST /topups/order`, `POST /giftcards/order`, `GET /orders/{id}`. */
export const orderReplySchema = z.object({ order: orderSchema });

export const statementPageSchema = z.object({
  items: z.array(z.unknown()),
  total: z.int().nullish(),
  page: z.int().nullish(),
  limit: z.int().nullish(),
});

export const transactionRowSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.string().max(64).nullish(),
  status: z.string().max(64).nullish(),
  amount: amount.nullish(),
  balanceAfter: amount.nullish(),
  note: z.string().max(2_000).nullish(),
  createdAt: z.string().max(64).nullish(),
});

export const orderRowSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.string().max(64).nullish(),
  offer_id: z.string().max(64).nullish(),
  card_id: z.string().max(64).nullish(),
  category_id: z.string().max(128).nullish(),
  quantity: z.int().nullish(),
  total_usd: amount.nullish(),
  created_at: z.string().max(64).nullish(),
  completed_at: z.string().max(64).nullish(),
});

/** `POST /topups/validate-id`: `player_name` is null when the id is not found. */
export const validateReplySchema = z.object({
  valid: z.boolean(),
  player_name: z.string().max(200).nullish(),
  region: z.string().max(64).nullish(),
});

/** `GET`, `PUT /account/webhook`; the secret is never read. */
export const webhookReplySchema = z.object({
  webhook: z
    .object({
      url: z.string().max(2_000).nullish(),
      enabled: z.boolean().nullish(),
      consecutive_failures: z.int().nullish(),
      last_success_at: z.string().max(64).nullish(),
      last_failure_at: z.string().max(64).nullish(),
      last_failure_reason: z.string().max(500).nullish(),
    })
    .nullable(),
});

export const deliveriesReplySchema = z.object({ deliveries: z.array(z.unknown()) });

export const deliverySchema = z.object({
  id: z.union([z.string().max(64), z.number()]),
  event: z.string().max(64),
  attempt: z.int().nullish(),
  status: z.string().max(32),
  response_status: z.int().nullish(),
  duration_ms: z.int().nullish(),
  created_at: z.string().max(64).nullish(),
});

/** A webhook body: the event id is in the signed body; `timestamp` is its only clock. */
export const webhookBodySchema = z.object({
  event: z.string().min(1).max(64),
  event_id: z.string().min(1).max(128),
  timestamp: z.union([z.string().max(64), z.number()]),
  data: z
    .object({
      order_id: z.string().max(64).nullish(),
      type: z.string().max(32).nullish(),
      status: z.string().max(32).nullish(),
      fail_reason: z.string().max(2_000).nullish(),
    })
    .nullish(),
});
