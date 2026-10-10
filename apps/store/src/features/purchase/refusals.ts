import { formatUsd } from '@vertex-digital/contracts';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';

/**
 * A purchase refusal's sentence: S12 LM4's daily cap says what remains today (`details.
 * remainingUnits`); every other code its own text.
 */
export function purchaseRefusalText(reason: Failure, details: unknown): string {
  if (reason === 'PURCHASE_LIMIT_EXCEEDED') {
    const remaining = (details as { remainingUnits?: unknown } | undefined)?.remainingUnits;
    if (typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining >= 0) {
      return t('purchase.capExceeded', { remaining: ltr(formatUsd(remaining)) });
    }
  }
  return errorText(reason);
}
