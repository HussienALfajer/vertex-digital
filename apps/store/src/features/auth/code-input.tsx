'use client';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { OtpField } from '@vertex-digital/ui/components/otp-field';
import { useId } from 'react';
import { t } from '@/lib/i18n';

/**
 * A 6-digit email code in six slots, as the panel's TOTP code (2026-10-15, F2-4): the
 * numeric keyboard on phones, the code from the email pasted whole into any slot (spaces
 * dropped), and the browser's one-time-code autofill on the first slot.
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
  const id = useId();
  return (
    <Field invalid={!!error}>
      <FieldLabel htmlFor={id}>{t('fields.code')}</FieldLabel>
      <OtpField
        id={id}
        name="code"
        autoFocus={autoFocus}
        value={value}
        onValueChange={onValueChange}
        slotLabel={(position) => t('fields.codeDigit', { position })}
        aria-invalid={error ? true : undefined}
      />
      <FieldDescription>{t('fields.codeHint')}</FieldDescription>
      <FieldError match={!!error} role="alert">
        {error}
      </FieldError>
    </Field>
  );
}
