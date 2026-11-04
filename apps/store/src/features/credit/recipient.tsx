'use client';

import type { StoreField } from '@vertex-digital/contracts';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { tcr } from './i18n';
import { operatorOf } from './section';

/**
 * RN2: the recipient typed a second time ("أعد كتابة الرقم"). Pasting is blocked, so the number
 * is typed twice by hand; the caller keeps "متابعة" off until both are one number.
 */
export function RepeatRecipient({
  field,
  value,
  mismatch,
  onChange,
  onBlur,
}: {
  field: StoreField;
  value: string;
  /** Both are typed and differ, and the customer left the field or pressed on. */
  mismatch: boolean;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  return (
    <Field invalid={mismatch}>
      <FieldLabel>{tcr('recipient.repeat')}</FieldLabel>
      <Input
        name={`${field.key}-repeat`}
        value={value}
        dir="ltr"
        inputMode={operatorOf(field) ? 'tel' : 'numeric'}
        type={operatorOf(field) ? 'tel' : 'text'}
        autoComplete="off"
        spellCheck={false}
        maxLength={32}
        className="h-11 text-md"
        aria-invalid={mismatch}
        onPaste={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <FieldDescription>{tcr('recipient.repeatHint')}</FieldDescription>
      <FieldError match={mismatch}>{tcr('recipient.mismatch')}</FieldError>
    </Field>
  );
}
