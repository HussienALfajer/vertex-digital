import { z } from 'zod';
import { catalogImageSchema, productKindSchema } from './catalog.js';
import { amountUnitsSchema } from './money.js';

/*
 * Availability and price-drop alerts (S22 F42, ADR 0037), owned by the api `catalog` module: a
 * customer asks to hear once, in the center and by push, when a pack comes back or gets cheaper on
 * the customer's own price list. The worker's `catalog.product-alerts` checks them every 15
 * minutes (PA3–PA6). No money moves.
 */

/** PA1: at most 30 active alerts per customer. */
export const PRODUCT_ALERTS_MAX = 30;

/** PA1: alert creations an hour per customer. */
export const PRODUCT_ALERTS_PER_HOUR = 30;

/** PA6: an unsent alert ends after 90 days. */
export const PRODUCT_ALERT_DAYS = 90;

/** Ended alerts are deleted 90 days after they ended (`orders.sweep`). */
export const PRODUCT_ALERT_RETENTION_DAYS = 90;

/** PA7: "تنبيهاتي" lists the last 20 ended alerts. */
export const PRODUCT_ALERTS_ENDED_SHOWN = 20;

/** PA3: the job reads at most this many active alerts per batch. */
export const PRODUCT_ALERTS_BATCH = 500;

export const PRODUCT_ALERT_KINDS = ['available', 'price_drop'] as const;

export const productAlertKindSchema = z.enum(PRODUCT_ALERT_KINDS).meta({ id: 'ProductAlertKind' });

export type ProductAlertKind = z.infer<typeof productAlertKindSchema>;

export const PRODUCT_ALERT_STATUSES = ['active', 'sent', 'cancelled', 'expired'] as const;

export const productAlertStatusSchema = z
  .enum(PRODUCT_ALERT_STATUSES)
  .meta({ id: 'ProductAlertStatus' });

export type ProductAlertStatus = z.infer<typeof productAlertStatusSchema>;

/** `PRODUCT_ALERT_INVALID`'s `details.reason` (PA1). */
export const PRODUCT_ALERT_INVALID_REASONS = ['available', 'unavailable', 'hidden'] as const;

export type ProductAlertInvalidReason = (typeof PRODUCT_ALERT_INVALID_REASONS)[number];

/**
 * PA1: why an alert of this kind cannot be set on the pack as it is now, or null. `available` on
 * an available pack, `price_drop` on a pack the customer cannot buy (no price), either on a pack
 * the store hides (a paused game, an archived pack).
 */
export function productAlertRefusal(
  kind: ProductAlertKind,
  pack: { hidden: boolean; available: boolean; unitPriceUsdUnits: number | null },
): ProductAlertInvalidReason | null {
  if (pack.hidden) return 'hidden';
  if (kind === 'available') return pack.available ? 'available' : null;
  return pack.available && pack.unitPriceUsdUnits !== null ? null : 'unavailable';
}

export type ProductAlertOutcome = 'available' | 'price_dropped' | 'rebase';

/**
 * PA3–PA5: what the job does with an active alert. `rebase` when the customer's effective list is
 * no longer the alert's (the alert moves to the new list's current price, nothing is sent);
 * `available` when an availability alert's pack is available; `price_dropped` when the pack is
 * available and its unit price is strictly below the baseline; null otherwise.
 */
export function alertDue(
  alert: { kind: ProductAlertKind; baselinePriceUsdUnits: number | null; priceListId: string },
  current: { priceListId: string; available: boolean; unitPriceUsdUnits: number | null },
): ProductAlertOutcome | null {
  if (alert.priceListId !== current.priceListId) return 'rebase';
  if (!current.available) return null;
  if (alert.kind === 'available') return 'available';
  return current.unitPriceUsdUnits !== null &&
    alert.baselinePriceUsdUnits !== null &&
    current.unitPriceUsdUnits < alert.baselinePriceUsdUnits
    ? 'price_dropped'
    : null;
}

/** `POST /api/product-alerts` (PA1): the price-drop baseline is the server's price, never sent. */
export const createProductAlertSchema = z
  .object({ productId: z.uuid(), kind: productAlertKindSchema })
  .meta({ id: 'CreateProductAlert' });

export type CreateProductAlert = z.infer<typeof createProductAlertSchema>;

/** `GET /api/product-alerts`: a game's active alerts (its page), or "تنبيهاتي"'s lists (PA7). */
export const productAlertListQuerySchema = z
  .object({
    gameId: z.uuid().optional(),
    status: z.enum(['active', 'ended']).default('active'),
  })
  .meta({ id: 'ProductAlertListQuery' });

export type ProductAlertListQuery = z.infer<typeof productAlertListQuerySchema>;

export const productAlertSchema = z
  .object({
    id: z.uuid(),
    kind: productAlertKindSchema,
    status: productAlertStatusSchema,
    product: z.object({ id: z.uuid(), nameAr: z.string(), kind: productKindSchema }),
    game: z.object({
      id: z.uuid(),
      slug: z.string(),
      nameAr: z.string(),
      cover: catalogImageSchema.nullable(),
    }),
    /** The unit price the customer saw when setting a price-drop alert (whole cents). */
    baselinePriceUsdUnits: amountUnitsSchema.nullable(),
    expiresAt: z.iso.datetime(),
    sentAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ProductAlert' });

export type ProductAlert = z.infer<typeof productAlertSchema>;

export const productAlertListSchema = z
  .object({ items: z.array(productAlertSchema) })
  .meta({ id: 'ProductAlertList' });

export type ProductAlertList = z.infer<typeof productAlertListSchema>;
