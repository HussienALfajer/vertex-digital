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

/**
 * S23 TR1 (ADR 0038): the merchant tiers, lowest first. Bronze is a merchant without a level; the
 * other three are the live levels with that tier. Here, beside the price kind a customer is told,
 * so `merchants.ts` and the store's pages read the tier without the tier rules.
 */
export const MERCHANT_TIERS = ['bronze', 'silver', 'gold', 'diamond'] as const;

export const merchantTierSchema = z.enum(MERCHANT_TIERS).meta({ id: 'MerchantTier' });

export type MerchantTier = z.infer<typeof merchantTierSchema>;

/** The tiers a level carries (TR1): every tier but Bronze. */
export const LEVEL_TIERS = ['silver', 'gold', 'diamond'] as const;

export const levelTierSchema = z.enum(LEVEL_TIERS).meta({ id: 'LevelTier' });

export type LevelTier = z.infer<typeof levelTierSchema>;
