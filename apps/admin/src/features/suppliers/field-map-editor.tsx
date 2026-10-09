import type { InputField } from '@vertex-digital/contracts';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vertex-digital/ui';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FieldMapEntry } from './field-map';

const NONE = 'none';

/**
 * Rule RT3: each supplier field mapped to an input field of the game. Required fields come from
 * the supplier; other fields are typed from its documentation when it publishes none. `missing`
 * marks the required fields the API reported unmapped.
 */
export function FieldMapEditor({
  entries,
  fields,
  missing = [],
  onChange,
}: {
  entries: FieldMapEntry[];
  /** The game's unarchived input fields. */
  fields: Pick<InputField, 'key' | 'labelAr'>[];
  missing?: readonly string[];
  onChange: (entries: FieldMapEntry[]) => void;
}) {
  const { t } = useTranslation();
  const items = [
    { value: NONE, label: t('suppliers.fieldMap.unmapped') },
    ...fields.map((field) => ({ value: field.key, label: field.labelAr })),
  ];
  const update = (index: number, next: Partial<FieldMapEntry>) =>
    onChange(entries.map((entry, at) => (at === index ? { ...entry, ...next } : entry)));

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-base font-medium">{t('suppliers.fieldMap.title')}</legend>
      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('suppliers.fieldMap.none')}</p>
      )}
      {entries.map((entry, index) => {
        const label = t('suppliers.fieldMap.target', { field: entry.field || '—' });
        return (
          <div
            // Rows are edited in place and only added or removed at the end.
            // biome-ignore lint/suspicious/noArrayIndexKey: a typed field name can change.
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2"
          >
            {entry.required ? (
              <span className="flex flex-col">
                <bdi dir="ltr" className="text-sm">
                  {entry.field}
                </bdi>
                {missing.includes(entry.field) && (
                  <span className="text-xs text-status-danger-foreground">
                    {t('suppliers.fieldMap.missing')}
                  </span>
                )}
              </span>
            ) : (
              <Input
                dir="ltr"
                autoComplete="off"
                aria-label={t('suppliers.fieldMap.supplierField')}
                placeholder={t('suppliers.fieldMap.supplierFieldPlaceholder')}
                value={entry.field}
                onChange={(event) => update(index, { field: event.target.value })}
              />
            )}
            <Select
              items={items}
              value={entry.key || NONE}
              onValueChange={(value) =>
                update(index, { key: value && value !== NONE ? value : '' })
              }
            >
              <SelectTrigger aria-label={label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {entry.required ? (
              <span aria-hidden="true" />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('suppliers.fieldMap.remove')}
                      onClick={() => onChange(entries.filter((_, at) => at !== index))}
                    />
                  }
                >
                  <Trash2Icon />
                </TooltipTrigger>
                <TooltipContent>{t('suppliers.fieldMap.remove')}</TooltipContent>
              </Tooltip>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange([...entries, { field: '', key: '', required: false }])}
      >
        <PlusIcon />
        {t('suppliers.fieldMap.add')}
      </Button>
    </fieldset>
  );
}
