import { z } from 'zod';

/*
 * What a customer is told about their prices (S20 AT4): never a list's name, rule or cost; and the
 * account's type (AT1). Apart from `pricing.ts` so `auth.ts`, `notifications.ts` and `merchants.ts`,
 * which store pages reach, do not bring the pricing, catalog and supplier schemas into them.
 */

export const PRICE_KINDS = ['retail', 'wholesale', 'special'] as const;

export const priceKindSchema = z.enum(PRICE_KINDS).meta({ id: 'PriceKind' });

export type PriceKind = z.infer<typeof priceKindSchema>;

/** An account's type (S20 AT1): what the person sees and the limits tier. */
export const ACCOUNT_TYPES = ['customer', 'merchant'] as const;

export const accountTypeSchema = z.enum(ACCOUNT_TYPES).meta({ id: 'AccountType' });

export type AccountType = z.infer<typeof accountTypeSchema>;
