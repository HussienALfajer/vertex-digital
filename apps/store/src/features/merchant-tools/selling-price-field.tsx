'use client';

import type { SaleCurrency } from '@vertex-digital/contracts';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { type ReadyPrice, type SalePriceDraft, switchSaleCurrency } from './form';
import { tm } from './i18n';

/**
 * A selling price as typed (S21 SP2, SP5, PS3): the currency, USD first, then the amount, checked
 * by the caller with `parseSellingPrice` or `manualSalePrice`. A currency change never carries a
 * typed amount over (`switchSaleCurrency`). Shared by the order page and the sale mode.
 */
export function SellingPriceField({
  draft,
  ready,
  invalid,
  label,
  onChange,
}: {
  draft: SalePriceDraft;
  ready: ReadyPrice;
  invalid: boolean;
  label: string;
  onChange: (draft: SalePriceDraft) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup<SaleCurrency>
        aria-label={tm('prices.currency')}
        value={[draft.currency]}
        onValueChange={(value) => value[0] && onChange(switchSaleCurrency(draft, value[0], ready))}
      >
        <ToggleGroupItem value="usd" className="h-11 px-4 text-md">
          {tm('prices.usd')}
        </ToggleGroupItem>
        <ToggleGroupItem value="syp" className="h-11 px-4 text-md">
          {tm('prices.syp')}
        </ToggleGroupItem>
      </ToggleGroup>
      <Field invalid={invalid}>
        <FieldLabel>{label}</FieldLabel>
        <Input
          name="sellingAmount"
          dir="ltr"
          inputMode={draft.currency === 'usd' ? 'decimal' : 'numeric'}
          autoComplete="off"
          className="h-11 text-md"
          value={draft.amount}
          onChange={(event) => onChange({ ...draft, amount: event.target.value, typed: true })}
        />
        <FieldError match={invalid}>
          {draft.currency === 'usd' ? tm('prices.amountInvalidUsd') : tm('prices.amountInvalidSyp')}
        </FieldError>
      </Field>
    </div>
  );
}
