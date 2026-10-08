import type { WalletEntry } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/**
 * What a timeline entry is called (rule W6): its deposit method (S03), its adjustment category,
 * "عكس: <category>" for a reversal, or its kind. Never the internal reason, the admin or a journal id.
 */
export function entryLabel(entry: WalletEntry): string {
  const adjustment = entry.adjustment;
  if (entry.deposit) return t(`wallet.depositMethods.${entry.deposit.method}`);
  if (!adjustment) return t(`wallet.kinds.${entry.kind}`);
  const category = t(`wallet.categories.${adjustment.category}`);
  return adjustment.reversal ? t('wallet.reversal', { category }) : category;
}
