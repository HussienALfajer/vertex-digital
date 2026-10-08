import { Link } from '@tanstack/react-router';
import {
  DEPOSIT_FLAG_DETAILS,
  type DepositFlag,
  type DepositFlagCode,
  formatUsd,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ltr } from '../../lib/format';
import { depositAmount } from './deposit-labels';
import { receiptUrl } from './deposits.queries';

/**
 * The deposit's flags (A10), each with its words and what was found. For a reused or similar
 * receipt (FL1, FL2), links open the other deposit and its receipt. The customer never sees them.
 */
export function DepositFlags({ flags }: { flags: DepositFlag[] }) {
  const { t } = useTranslation();
  if (flags.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('deposits.flags.none')}</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {flags.map((flag) => (
        <li key={flag.id} className="flex flex-col gap-1 rounded-md border border-border p-3">
          <Badge tone="warning">{t(`deposits.flags.${flag.code}.label`)}</Badge>
          <p className="text-sm">{t(`deposits.flags.${flag.code}.description`)}</p>
          <FlagDetails flag={flag} />
        </li>
      ))}
    </ul>
  );
}

/** The details as their contract reads them; anything unexpected shows nothing more. */
function FlagDetails({ flag }: { flag: DepositFlag }) {
  const { t } = useTranslation();
  const line = detailLine(t, flag.code, flag.details);
  if (line) return <p className="text-sm text-muted-foreground tabular-nums">{line}</p>;
  const matches = matchesOf(flag);
  if (matches.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {matches.map((match) => (
        <li key={match.receiptId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            to="/deposits/$id"
            params={{ id: match.depositId }}
            className="rounded-sm underline underline-offset-4"
          >
            {t('deposits.flags.otherDeposit')}
          </Link>
          <a
            href={receiptUrl(match.depositId, match.receiptId)}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm underline underline-offset-4"
          >
            {t('deposits.flags.otherReceipt')}
          </a>
          {match.distance !== undefined && (
            <span className="text-muted-foreground">
              {t('deposits.flags.distance', { distance: match.distance })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface Match {
  depositId: string;
  receiptId: string;
  distance?: number;
}

function matchesOf(flag: DepositFlag): Match[] {
  if (flag.code === 'receipt_reused') {
    const parsed = DEPOSIT_FLAG_DETAILS.receipt_reused.safeParse(flag.details);
    return parsed.success ? parsed.data.matches : [];
  }
  if (flag.code === 'receipt_similar') {
    const parsed = DEPOSIT_FLAG_DETAILS.receipt_similar.safeParse(flag.details);
    return parsed.success ? parsed.data.matches : [];
  }
  return [];
}

/** One line for the flags whose details are numbers. */
export function detailLine(t: TFunction, code: DepositFlagCode, details: unknown): string | null {
  switch (code) {
    case 'new_account_large': {
      const parsed = DEPOSIT_FLAG_DETAILS.new_account_large.safeParse(details);
      if (!parsed.success) return null;
      return t('deposits.flags.newAccountLine', {
        declared: ltr(formatUsd(parsed.data.declaredUsdUnits)),
        threshold: ltr(formatUsd(parsed.data.thresholdUnits)),
      });
    }
    case 'velocity': {
      const parsed = DEPOSIT_FLAG_DETAILS.velocity.safeParse(details);
      if (!parsed.success) return null;
      return t('deposits.flags.velocityLine', parsed.data);
    }
    case 'shared_phone': {
      const parsed = DEPOSIT_FLAG_DETAILS.shared_phone.safeParse(details);
      if (!parsed.success) return null;
      return t('deposits.flags.sharedPhoneLine', { customers: parsed.data.count });
    }
    case 'amount_mismatch': {
      const parsed = DEPOSIT_FLAG_DETAILS.amount_mismatch.safeParse(details);
      if (!parsed.success) return null;
      const { declaredCurrency, declaredAmountUnits, receivedCurrency, receivedAmountUnits } =
        parsed.data;
      return t('deposits.flags.mismatchLine', {
        declared: depositAmount(t, declaredCurrency, declaredAmountUnits),
        received: depositAmount(t, receivedCurrency, receivedAmountUnits),
      });
    }
    default:
      return null;
  }
}
