import { orderFieldValuesSchema, type StoreField } from '@vertex-digital/contracts';
import { t } from '@/lib/i18n';

/*
 * The buy box's fields (S09 rule BB2): checked in the browser with the same CT7 schema the server
 * uses (`orderFieldValuesSchema`), so a value the store accepts is one the API accepts.
 */

export type FieldValues = Record<string, string>;

export type FieldsCheck =
  | { ok: true; values: FieldValues }
  | { ok: false; errors: Record<string, string> };

/** The values as the server will read them (trimmed, phones in E.164), or a message per field. */
export function checkFields(fields: readonly StoreField[], typed: FieldValues): FieldsCheck {
  const input: FieldValues = {};
  for (const field of fields) input[field.key] = typed[field.key] ?? '';
  const parsed = orderFieldValuesSchema(fields).safeParse(input);
  if (parsed.success) return { ok: true, values: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0]);
    const field = fields.find((item) => item.key === key);
    if (!field || errors[key]) continue;
    errors[key] = fieldMessage(field, input[key] ?? '');
  }
  return { ok: false, errors };
}

function fieldMessage(field: StoreField, value: string): string {
  if (value.trim() === '') return t('purchase.fieldErrors.required');
  switch (field.type) {
    case 'digits':
      return field.minLength === field.maxLength && field.minLength !== null
        ? t('purchase.fieldErrors.digitsExact', { length: field.minLength })
        : t('purchase.fieldErrors.digits', {
            min: field.minLength ?? 1,
            max: field.maxLength ?? 32,
          });
    case 'text':
      return t('purchase.fieldErrors.text', {
        min: field.minLength ?? 1,
        max: field.maxLength ?? 64,
      });
    case 'phone':
      return t('purchase.fieldErrors.phone');
    case 'select':
      return t('purchase.fieldErrors.select');
  }
}
