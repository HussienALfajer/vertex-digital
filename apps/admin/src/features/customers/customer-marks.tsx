import { Link } from '@tanstack/react-router';
import type { CustomerMarks as Marks } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui';
import { PinIcon, TriangleAlertIcon, UserRoundIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CHIP_TONES, statusChips } from './customer-labels';

/**
 * Rule CS6: what the panel shows beside a customer on a deposit, an order or a ticket: the status
 * chips, the pinned note, the signals count and a link to the profile.
 */
export function CustomerMarks({
  customerId,
  marks,
  isTest,
}: {
  customerId: string;
  marks: Marks;
  isTest: boolean;
}) {
  const { t } = useTranslation();
  const chips = statusChips(marks.status, isTest).filter((chip) => chip !== 'test');
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {chips.map((chip) => (
          <Badge key={chip} tone={CHIP_TONES[chip]}>
            {t(`customers.chips.${chip}`)}
          </Badge>
        ))}
        {marks.signalsCount > 0 && (
          <Link
            to="/customers/$id"
            params={{ id: customerId }}
            className="flex items-center gap-1 rounded-sm font-medium text-status-warning-foreground underline-offset-4 hover:underline"
          >
            <TriangleAlertIcon className="size-4" aria-hidden="true" />
            {t('customers.marks.signals', { count: marks.signalsCount })}
          </Link>
        )}
        <Link
          to="/customers/$id"
          params={{ id: customerId }}
          className="flex items-center gap-1 rounded-sm font-medium underline-offset-4 hover:underline"
        >
          <UserRoundIcon className="size-4" aria-hidden="true" />
          {t('customers.marks.profile')}
        </Link>
      </div>
      {marks.pinnedNote && (
        <p className="flex items-start gap-2 rounded-md bg-status-gold px-3 py-2 text-status-gold-foreground">
          <PinIcon className="mt-0.5 size-4 shrink-0" aria-label={t('customers.marks.pinned')} />
          <span className="whitespace-pre-wrap break-words">{marks.pinnedNote}</span>
        </p>
      )}
    </div>
  );
}
