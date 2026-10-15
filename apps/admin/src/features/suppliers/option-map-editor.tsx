import type { FieldSpec, InputField, OptionMap } from '@vertex-digital/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';

const NONE = 'none';

/** The supplier's select options by field key (the first spec of each key). */
export function supplierSelects(
  specs: readonly FieldSpec[],
): Record<string, NonNullable<FieldSpec['options']>> {
  const selects: Record<string, NonNullable<FieldSpec['options']>> = {};
  for (const spec of specs) {
    if (spec.type === 'select' && !Object.hasOwn(selects, spec.key)) {
      selects[spec.key] = spec.options ?? [];
    }
  }
  return selects;
}

/** The option values of the game's `select` fields, by key (RT3 with option maps). */
export function gameSelects(
  fields: readonly Pick<InputField, 'key' | 'options'>[],
): Record<string, string[]> {
  return Object.fromEntries(
    fields.flatMap((field) =>
      field.options ? [[field.key, field.options.map((option) => option.value)]] : [],
    ),
  );
}

/**
 * S16 MF2, MF3: for each supplier select the field map sends from one of the game's fields, each
 * of the game's options mapped to one of the supplier's (the value sent). A supplier select mapped
 * to a field that is not a select cannot be sent. `missing` marks the supplier keys the API or
 * the form found incomplete.
 */
export function OptionMapEditor({
  fieldMap,
  fields,
  supplierOptions,
  optionMap,
  missing = [],
  onChange,
}: {
  fieldMap: Readonly<Record<string, string>>;
  /** The game's unarchived input fields. */
  fields: readonly Pick<InputField, 'key' | 'labelAr' | 'type' | 'options'>[];
  supplierOptions: Readonly<Record<string, NonNullable<FieldSpec['options']>>>;
  optionMap: OptionMap;
  missing?: readonly string[];
  onChange: (optionMap: OptionMap) => void;
}) {
  const { t } = useTranslation();
  const mapped = Object.entries(fieldMap).filter(([supplierKey]) =>
    Object.hasOwn(supplierOptions, supplierKey),
  );
  if (mapped.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 text-base font-medium">{t('suppliers.optionMap.title')}</legend>
      <p className="text-sm text-muted-foreground">{t('suppliers.optionMap.hint')}</p>
      {mapped.map(([supplierKey, key]) => {
        const field = fields.find((candidate) => candidate.key === key);
        const theirs = supplierOptions[supplierKey] ?? [];
        const items = [
          { value: NONE, label: t('suppliers.optionMap.unmapped') },
          ...theirs.map((option) => ({
            value: option.value,
            label:
              option.label === option.value ? option.value : `${option.label} (${option.value})`,
          })),
        ];
        const values = optionMap[supplierKey] ?? {};
        const set = (value: string, sent: string | null) => {
          const next = { ...values };
          if (sent === null) delete next[value];
          else next[value] = sent;
          onChange({ ...optionMap, [supplierKey]: next });
        };
        return (
          <div
            key={supplierKey}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
            data-invalid={missing.includes(supplierKey) ? '' : undefined}
          >
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <bdi dir="ltr" className="font-medium">
                {supplierKey}
              </bdi>
              <span className="text-muted-foreground">←</span>
              <bdi>{field?.labelAr ?? key}</bdi>
            </div>
            {missing.includes(supplierKey) && (
              <p role="alert" className="text-xs text-status-danger-foreground">
                {t('suppliers.optionMap.missing')}
              </p>
            )}
            {!field?.options ? (
              <p className="text-sm text-status-danger-foreground">
                {t('suppliers.optionMap.needsSelect')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {field.options.map((option) => (
                  <li
                    key={option.value}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-2"
                  >
                    <bdi className="text-sm">{option.labelAr}</bdi>
                    <Select
                      items={items}
                      value={values[option.value] ?? NONE}
                      onValueChange={(value) =>
                        set(option.value, value && value !== NONE ? value : null)
                      }
                    >
                      <SelectTrigger
                        aria-label={t('suppliers.optionMap.target', { option: option.labelAr })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {items.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            <bdi dir="auto">{item.label}</bdi>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
