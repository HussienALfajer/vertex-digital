import type { AdminWalletEntry } from '@vertex-digital/contracts';
import type { TFunction } from 'i18next';

/** What a timeline entry is: its adjustment category, "عكس: <category>", or its journal kind. */
export function entryLabel(t: TFunction, entry: AdminWalletEntry): string {
  const adjustment = entry.adjustment;
  if (!adjustment) return t(`wallets.kinds.${entry.kind}`);
  const category = t(`wallets.categories.${adjustment.category}`);
  return adjustment.reversal ? t('wallets.detail.reversal', { category }) : category;
}

/** The id of an adjustment's timeline row, for the links between an original and its reversal. */
export const adjustmentRowId = (id: string) => `adjustment-${id}`;
