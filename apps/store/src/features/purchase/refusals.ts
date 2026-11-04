import { formatUsd } from '@vertex-digital/contracts';
import { tcr } from '@/features/credit/i18n';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { t } from '@/lib/i18n';

const units = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const usd = (value: number) => ltr(formatUsd(value));

/**
 * A purchase refusal's sentence: S12 LM4's daily cap says what remains today (`details.
 * remainingUnits`); S25's section limits say what remains (CL2, CS2), the number's daily count
 * (CL3), or the balance a cash order may use now and when more becomes eligible (CS1); every other
 * code its own text.
 */
export function purchaseRefusalText(reason: Failure, details: unknown): string {
  const found = (details ?? {}) as Record<string, unknown>;
  switch (reason) {
    case 'PURCHASE_LIMIT_EXCEEDED':
      if (units(found.remainingUnits))
        return t('purchase.capExceeded', { remaining: usd(found.remainingUnits) });
      break;
    case 'CREDIT_DAILY_LIMIT':
    case 'CASH_DAILY_LIMIT':
      if (units(found.remainingUsdUnits))
        return tcr(reason === 'CASH_DAILY_LIMIT' ? 'limits.cash' : 'limits.credit', {
          remaining: usd(found.remainingUsdUnits),
        });
      break;
    case 'RECIPIENT_DAILY_LIMIT':
      if (units(found.limit)) return tcr('limits.recipient', { limit: found.limit });
      break;
    case 'CASH_BALANCE_TOO_RECENT':
      if (units(found.eligibleUsdUnits)) {
        const at = typeof found.eligibleMoreAt === 'string' ? found.eligibleMoreAt : null;
        return at
          ? tcr('limits.recentMore', {
              eligible: usd(found.eligibleUsdUnits),
              at: formatDateTime(at),
            })
          : tcr('limits.recent', { eligible: usd(found.eligibleUsdUnits) });
      }
      break;
  }
  return errorText(reason);
}
