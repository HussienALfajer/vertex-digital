'use client';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { t } from '@/lib/i18n';

/**
 * A 6-digit email code in one field: the numeric keyboard on phones, the code from the email
 * pasted whole (spaces and other characters dropped), and the browser's one-time-code autofill.
 */
export function CodeInput({
  value,
  onValueChange,
  error,
  autoFocus,
}: {
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  autoFocus?: boolean;
}) {
  return (
    <Field invalid={!!error}>
      <FieldLabel>{t('fields.code')}</FieldLabel>
      <Input
        name="code"
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        className="h-12 text-center text-xl font-medium tabular-nums"
        value={value}
        onChange={(event) => onValueChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        aria-invalid={!!error}
      />
      <FieldDescription>{t('fields.codeHint')}</FieldDescription>
      <FieldError match={!!error} role="alert">
        {error}
      </FieldError>
    </Field>
  );
}
