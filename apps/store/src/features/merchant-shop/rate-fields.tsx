'use client';

import { exchangeRateSchema, formatRate, type ShopRateMode } from '@vertex-digital/contracts';
import { Callout } from '@vertex-digital/ui/components/callout';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { TriangleAlertIcon } from 'lucide-react';
import { tsa } from './i18n';
import { CONFIRM_WORD, confirmWordTyped } from './rules';

export type RateDraft = { mode: ShopRateMode; rate: string; confirm: string };

/** The own rate as the API takes it, or null while the field holds none. */
export function typedRate(draft: RateDraft): string | null {
  const parsed = exchangeRateSchema.safeParse(draft.rate);
  return parsed.success ? parsed.data : null;
}

/**
 * ST3: the store's rate or an own one; an own rate more than 10% from the store's asks for
 * «أؤكد» typed. `far` holds the store's rate once the server said the rate is far (or the page
 * knows it): the warning and the confirmation field show then.
 */
export function RateFields({
  draft,
  onChange,
  far,
  showError,
}: {
  draft: RateDraft;
  onChange: (draft: RateDraft) => void;
  far: { storeRate: string | null } | null;
  showError: boolean;
}) {
  const rateInvalid = draft.mode === 'own' && typedRate(draft) === null;
  const confirmInvalid = far !== null && !confirmWordTyped(draft.confirm);
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel render={<span />}>{tsa('request.rate')}</FieldLabel>
        <ToggleGroup<ShopRateMode>
          aria-label={tsa('request.rate')}
          value={[draft.mode]}
          onValueChange={(value) => value[0] && onChange({ ...draft, mode: value[0] })}
        >
          <ToggleGroupItem value="store" className="h-11 px-4 text-md">
            {tsa('request.rateStore')}
          </ToggleGroupItem>
          <ToggleGroupItem value="own" className="h-11 px-4 text-md">
            {tsa('request.rateOwn')}
          </ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription>
          {draft.mode === 'store' ? tsa('request.rateStoreHint') : tsa('request.rateOwnHint')}
        </FieldDescription>
      </Field>
      {draft.mode === 'own' && (
        <Field invalid={showError && rateInvalid}>
          <FieldLabel>{tsa('request.rateValue')}</FieldLabel>
          <Input
            name="rate"
            dir="ltr"
            inputMode="decimal"
            className="h-11 max-w-48 text-md"
            value={draft.rate}
            aria-invalid={showError && rateInvalid}
            onChange={(event) => onChange({ ...draft, rate: event.target.value, confirm: '' })}
          />
          <FieldError match={showError && rateInvalid}>{tsa('request.rateInvalid')}</FieldError>
        </Field>
      )}
      {draft.mode === 'own' && far && (
        <div className="flex flex-col gap-3" data-testid="rate-far">
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={tsa('request.rateFarTitle')}
            description={tsa('request.rateFarBody', {
              rate: far.storeRate ? formatRate(far.storeRate) : '—',
            })}
          />
          <Field invalid={showError && confirmInvalid}>
            <FieldLabel>{tsa('request.rateFarLabel')}</FieldLabel>
            <Input
              name="confirmFar"
              className="h-11 max-w-48 text-md"
              placeholder={CONFIRM_WORD}
              value={draft.confirm}
              aria-invalid={showError && confirmInvalid}
              onChange={(event) => onChange({ ...draft, confirm: event.target.value })}
            />
            <FieldError match={showError && confirmInvalid}>
              {tsa('request.rateFarInvalid')}
            </FieldError>
          </Field>
        </div>
      )}
    </div>
  );
}
