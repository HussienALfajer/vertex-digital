'use client';

import type { SaleCurrency } from '@vertex-digital/contracts';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { tm } from './i18n';

/**
 * A selling price as typed (S21 SP2, SP5, PS3): the currency, then the amount, checked by the
 * caller with `parseSellingPrice`. Shared by the order page and the point of sale.
 */
export function SellingPriceField({
  currency,
  amount,
  invalid,
  label,
  onCurrency,
  onAmount,
}: {
  currency: SaleCurrency;
  amount: string;
  invalid: boolean;
  label: string;
  onCurrency: (currency: SaleCurrency) => void;
  onAmount: (amount: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup<SaleCurrency>
        aria-label={tm('prices.currency')}
        value={[currency]}
        onValueChange={(value) => value[0] && onCurrency(value[0])}
      >
        <ToggleGroupItem value="syp" className="h-11 px-4 text-md">
          {tm('prices.syp')}
        </ToggleGroupItem>
        <ToggleGroupItem value="usd" className="h-11 px-4 text-md">
          {tm('prices.usd')}
        </ToggleGroupItem>
      </ToggleGroup>
      <Field invalid={invalid}>
        <FieldLabel>{label}</FieldLabel>
        <Input
          name="sellingAmount"
          dir="ltr"
          inputMode={currency === 'usd' ? 'decimal' : 'numeric'}
          autoComplete="off"
          className="h-11 text-md"
          value={amount}
          onChange={(event) => onAmount(event.target.value)}
        />
        <FieldError match={invalid}>
          {currency === 'usd' ? tm('prices.amountInvalidUsd') : tm('prices.amountInvalidSyp')}
        </FieldError>
      </Field>
    </div>
  );
}
