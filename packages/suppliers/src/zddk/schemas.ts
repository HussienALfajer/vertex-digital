import { z } from 'zod';

/*
 * The replies of a zddk store's reseller API (docs/suppliers/jneedcontur.md), from the store's
 * public documentation (`https://api.jneedcontur.net/api-docs`, read 2026-11-04 and 2026-11-05):
 * no live reply has been recorded yet. Only the success shapes are documented (Q32): a reply that
 * does not match one is never trusted. Lists are read item by item, so one unreadable product never
 * hides the others.
 */

/** Prices are JSON numbers in `products` and `newOrder` (`1.26048`), decimal strings in `check`. */
const amount = z.union([z.number(), z.string().max(64)]);

/** `GET profile`: `{ balance: "8788.683", email }`; the currency is not named (Q35). */
export const profileReplySchema = z.object({
  balance: amount,
});

/** `GET products` (and `?products_id=`): an array of products. */
export const productsReplySchema = z.array(z.unknown());

/**
 * `qty_values`: null (the quantity is 1), a list of the only quantities allowed, or a range; the
 * values are numbers or strings (`{ "min": 1, "max": "15000" }`).
 */
const quantity = z.union([z.number(), z.string().max(32)]);

export const productSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(500),
  price: amount,
  base_price: amount.nullish(),
  /** Arabic labels of the order's fields (`["ادخل الايدي الاعب"]`), not their keys (Q31). */
  params: z.array(z.unknown()).nullish(),
  category_name: z.string().max(500).nullish(),
  category_img: z.string().max(2_000).nullish(),
  available: z.boolean(),
  qty_values: z.union([z.array(quantity), z.object({ min: quantity, max: quantity })]).nullish(),
  product_type: z.string().max(32).nullish(),
  /** The category the product is listed in; 0 is the store's home page. */
  parent_id: z.number().int().nonnegative().nullish(),
});

export type ZddkProduct = z.infer<typeof productSchema>;

/**
 * `replay_api`: null, `[{ "replay": ["…"] }]` in `newOrder`, `["…"]` in `check`: the provider's
 * texts, read as either shape.
 */
const replaySchema = z.unknown();

const orderStatus = z.string().min(1).max(32);

/** `GET newOrder/<id>/params?…`: `{ status: "OK", data: { order_id, status, price, … } }`. */
export const newOrderReplySchema = z.object({
  status: z.literal('OK'),
  data: z.object({
    order_id: z.string().min(1).max(128),
    status: orderStatus,
    price: amount.nullish(),
    replay_api: replaySchema.nullish(),
  }),
});

export type ZddkNewOrder = z.infer<typeof newOrderReplySchema>['data'];

/** `GET check?orders=[…]&uuid=1`: `{ status: "OK", data: [{ order_id, status, price, … }] }`. */
export const checkReplySchema = z.object({
  status: z.literal('OK'),
  data: z.array(
    z.object({
      order_id: z.string().min(1).max(128),
      status: orderStatus,
      price: amount.nullish(),
      replay_api: replaySchema.nullish(),
    }),
  ),
});
