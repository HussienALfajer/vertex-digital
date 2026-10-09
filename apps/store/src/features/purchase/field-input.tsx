'use client';

import type { StoreField } from '@vertex-digital/contracts';
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
import { t } from '@/lib/i18n';

/**
 * One input field of the buy box (rule BB1): its label and help, `dir="ltr"` for digits and
 * phones, the numeric keyboard for digits, options for a select, and its error under it (BB2).
 */
export function FieldInput({
  field,
  value,
  error,
  onChange,
  onBlur,
}: {
  field: StoreField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const label = field.required ? field.labelAr : t('purchase.optional', { label: field.labelAr });
  if (field.type === 'select') {
    const items = (field.options ?? []).map((option) => ({
      value: option.value,
      label: option.labelAr,
    }));
    return (
      <Field invalid={!!error}>
        <FieldLabel render={<span />}>{label}</FieldLabel>
        <Select
          items={items}
          value={value || null}
          onValueChange={(next) => {
            onChange(next ?? '');
            onBlur();
          }}
        >
          <SelectTrigger aria-label={field.labelAr} className="h-11 w-full text-md">
            <SelectValue placeholder={t('purchase.choose')} />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.helpAr && <FieldDescription>{field.helpAr}</FieldDescription>}
        <FieldError match={!!error}>{error}</FieldError>
      </Field>
    );
  }
  const latin = field.type === 'digits' || field.type === 'phone';
  return (
    <Field invalid={!!error}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        name={field.key}
        value={value}
        dir={latin ? 'ltr' : undefined}
        inputMode={field.type === 'digits' ? 'numeric' : field.type === 'phone' ? 'tel' : 'text'}
        type={field.type === 'phone' ? 'tel' : 'text'}
        autoComplete="off"
        spellCheck={false}
        maxLength={field.type === 'digits' ? 32 : field.type === 'phone' ? 32 : 64}
        className="h-11 text-md"
        aria-invalid={!!error}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {field.helpAr && <FieldDescription>{field.helpAr}</FieldDescription>}
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}
