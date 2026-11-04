'use client';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { tcr } from './i18n';
import { type AmountPack, amountBounds } from './section';

/**
 * AM1: the free amount, typed on the numeric keypad in the pack's unit, with its bounds and step
 * under it; the caller turns it into units (`amountQuantity`) and shows the live totals.
 */
export function AmountField({
  pack,
  value,
  invalid,
  onChange,
  onBlur,
}: {
  pack: AmountPack;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  const bounds = amountBounds(pack);
  return (
    <Field invalid={invalid}>
      <FieldLabel>{tcr('amount.label', { unit: bounds.unit })}</FieldLabel>
      <Input
        name="amount"
        value={value}
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        maxLength={9}
        placeholder={bounds.min}
        className="h-11 text-md tabular-nums"
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <FieldDescription>{tcr('amount.hint', bounds)}</FieldDescription>
      <FieldError match={invalid}>{tcr('amount.invalid', bounds)}</FieldError>
    </Field>
  );
}
