import type { AdminWalletEntry } from '@vertex-digital/contracts';
import type { TFunction } from 'i18next';

/**
 * What a timeline entry is: its deposit method, its adjustment category, "عكس: <category>", the
 * product and order of a purchase or refund (S08), or its journal kind.
 */
export function entryLabel(t: TFunction, entry: AdminWalletEntry): string {
  const adjustment = entry.adjustment;
  if (entry.deposit) return t(`wallets.depositMethods.${entry.deposit.method}`);
  // S08: a purchase or its refund names the product and the order number.
  if (entry.order) {
    return t(`wallets.orderKinds.${entry.kind === 'refund' ? 'refund' : 'purchase'}`, {
      product: entry.order.productNameAr,
      number: entry.order.number,
    });
  }
  if (!adjustment) return t(`wallets.kinds.${entry.kind}`);
  const category = t(`wallets.categories.${adjustment.category}`);
  return adjustment.reversal ? t('wallets.detail.reversal', { category }) : category;
}

/** The id of an adjustment's timeline row, for the links between an original and its reversal. */
export const adjustmentRowId = (id: string) => `adjustment-${id}`;
