import { z } from 'zod';

/*
 * What a customer is told about their prices (S20 AT4): never a list's name, rule or cost. Apart
 * from `pricing.ts` so `auth.ts` and `notifications.ts`, which every store page reaches, do not
 * bring the pricing, catalog and supplier schemas into its first load.
 */

export const PRICE_KINDS = ['retail', 'wholesale', 'special'] as const;

export const priceKindSchema = z.enum(PRICE_KINDS).meta({ id: 'PriceKind' });

export type PriceKind = z.infer<typeof priceKindSchema>;
