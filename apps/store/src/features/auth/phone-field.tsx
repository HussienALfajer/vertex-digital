'use client';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui/components/select';
import { useId, useMemo } from 'react';
import { t } from '@/lib/i18n';
import { type CountryCode, countryOptions, formatPhone, toE164 } from './phone';

/**
 * A phone number with its country (Syria first). The number is typed as people write it (`0944…`,
 * `+963…`); the form turns it into E.164 with `toE164`. Numbers read left to right, so the country
 * code sits before the number in both directions.
 */
export function PhoneField({
  country,
  onCountryChange,
  value,
  onValueChange,
  error,
  name = 'phone',
}: {
  country: CountryCode;
  onCountryChange: (country: CountryCode) => void;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  name?: string;
}) {
  const id = useId();
  const options = useMemo(() => countryOptions(), []);
  const dialCode = options.find((option) => option.code === country)?.dialCode;
  return (
    <Field invalid={!!error}>
      <FieldLabel htmlFor={id}>{t('fields.phone')}</FieldLabel>
      <div dir="ltr" className="flex gap-2">
        {/* Its own field: the phone label names the number, the country has its own name. */}
        <Field className="shrink-0">
          <Select
            value={country}
            onValueChange={(next) => next && onCountryChange(next as CountryCode)}
          >
            <SelectTrigger
              aria-label={t('fields.country')}
              className="h-11 w-auto min-w-24 shrink-0 text-md"
            >
              <SelectValue>{() => dialCode}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {options.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  <span dir="rtl" className="flex w-full justify-between gap-4">
                    <span>{option.name}</span>
                    <span dir="ltr" className="text-muted-foreground tabular-nums">
                      {option.dialCode}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Input
          id={id}
          name={name}
          type="tel"
          dir="ltr"
          autoComplete="tel-national"
          inputMode="tel"
          className="h-11 flex-1 text-md"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          // `0944123456` becomes `+963 944 123 456`: the customer sees the number we will keep.
          onBlur={() => {
            const e164 = toE164(value, country);
            if (e164) onValueChange(formatPhone(e164));
          }}
          aria-invalid={!!error}
        />
      </div>
      <FieldDescription>{t('fields.phoneHint')}</FieldDescription>
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}
