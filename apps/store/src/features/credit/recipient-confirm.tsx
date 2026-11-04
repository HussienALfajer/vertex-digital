'use client';

import type { StoreField } from '@vertex-digital/contracts';
import { PhoneIcon } from 'lucide-react';
import { FormAlert } from '@/components/form-alert';
import { t } from '@/lib/i18n';
import { tcr } from './i18n';
import { operatorOf, shownRecipient } from './section';

/**
 * RN2, D8: before slide-to-pay, the number large, left to right and grouped `09X XXX XXXX`, the
 * operator's name, and that credit sent to a wrong number is not refunded.
 */
export function RecipientConfirm({
  field,
  value,
}: {
  /** The recipient field, or its type alone (a cart line keeps only that). */
  field: Pick<StoreField, 'type'>;
  value: string;
}) {
  const operator = operatorOf(field);
  return (
    <div className="flex flex-col gap-3 rounded-lg border-2 border-status-warning p-4">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <PhoneIcon className="size-4" aria-hidden="true" />
          {tcr('recipient.label')}
          {operator && (
            <>
              {' · '}
              {tcr('recipient.operator', { operator: t(`purchase.operators.${operator}`) })}
            </>
          )}
        </span>
        <bdi
          dir="ltr"
          data-testid="recipient-confirm"
          className="text-end text-3xl font-bold tabular-nums"
        >
          {shownRecipient(field, value)}
        </bdi>
      </div>
      <FormAlert tone="warning">{tcr('recipient.warning')}</FormAlert>
    </div>
  );
}
