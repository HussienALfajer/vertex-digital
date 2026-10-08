import {
  createInputFieldSchema,
  INPUT_FIELD_TYPES,
  type InputField,
  type InputFieldType,
  inputFieldShapeSchema,
  type SelectOption,
  updateInputFieldSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vertex-digital/ui';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { useCreateField, useUpdateField } from './catalog.queries';
import { catalogFailure } from './catalog-parts';

type FieldName = 'key' | 'labelAr' | 'helpAr' | 'bounds' | 'options';

/** Length bounds exist for these types (rule CT7). */
const BOUNDED: readonly InputFieldType[] = ['digits', 'text'];

const bound = (text: string) => (text.trim() === '' ? null : Number(text.trim()));

/**
 * Add or edit an input field (rule CT7): the key and type are fixed at creation; the bounds or the
 * options follow the type. Validated with the API's own schemas.
 */
export function FieldDialog({
  gameId,
  field,
  onDone,
}: {
  gameId: string;
  /** Null to add a field. */
  field: InputField | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateField(gameId);
  const update = useUpdateField();
  const requiredId = useId();
  const [type, setType] = useState<InputFieldType>(field?.type ?? 'digits');
  const [required, setRequired] = useState(field?.required ?? true);
  const [options, setOptions] = useState<SelectOption[]>(
    field?.options ?? [
      { value: '', labelAr: '' },
      { value: '', labelAr: '' },
    ],
  );
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const bounded = BOUNDED.includes(type);
    const shape = {
      type,
      minLength: bounded ? bound(text('minLength')) : null,
      maxLength: bounded ? bound(text('maxLength')) : null,
      options:
        type === 'select'
          ? options.map((option) => ({
              value: option.value.trim(),
              labelAr: option.labelAr.trim(),
            }))
          : null,
    };
    const values = { labelAr: text('labelAr'), helpAr: text('helpAr') || null, required };
    const found: typeof errors = {};
    const shapeCheck = inputFieldShapeSchema.safeParse(shape);
    for (const issue of shapeCheck.error?.issues ?? []) {
      found[issue.path[0] === 'options' ? 'options' : 'bounds'] = t(
        `catalog.inputFields.errors.${issue.path[0] === 'options' ? 'options' : 'bounds'}`,
      );
    }
    const parsed = field
      ? updateInputFieldSchema.safeParse({
          ...values,
          minLength: shape.minLength,
          maxLength: shape.maxLength,
          options: shape.options,
        })
      : createInputFieldSchema.safeParse({ ...shape, ...values, key: text('key') });
    for (const issue of parsed.error?.issues ?? []) {
      const path = String(issue.path[0]);
      if (path === 'key' || path === 'labelAr' || path === 'helpAr') {
        found[path] = t(`catalog.inputFields.errors.${path}`);
      }
    }
    setErrors(found);
    if (!parsed.success || !shapeCheck.success || Object.keys(found).length > 0) return;
    try {
      if (field) await update.mutateAsync({ id: field.id, body: parsed.data });
      else await create.mutateAsync(parsed.data as Parameters<typeof create.mutateAsync>[0]);
      onDone();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'FIELD_KEY_TAKEN') {
        setErrors({ key: catalogFailure(t, error) });
      } else {
        setFailure(catalogFailure(t, error));
      }
    }
  }

  const types = INPUT_FIELD_TYPES.map((value) => ({
    value,
    label: t(`catalog.inputFields.types.${value}`),
  }));

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {field ? t('catalog.inputFields.editTitle') : t('catalog.inputFields.addTitle')}
        </DialogTitle>
        <DialogDescription>{t('catalog.inputFields.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field invalid={!!errors.key}>
            <FieldLabel>{t('catalog.inputFields.key')}</FieldLabel>
            <Input
              name="key"
              dir="ltr"
              defaultValue={field?.key}
              readOnly={!!field}
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              placeholder="player_id"
            />
            <FieldDescription>
              {field ? t('catalog.inputFields.fixed') : t('catalog.inputFields.keyHint')}
            </FieldDescription>
            <FieldError match={!!errors.key}>{errors.key}</FieldError>
          </Field>
          <Field>
            <FieldLabel render={<span />}>{t('catalog.inputFields.type')}</FieldLabel>
            <Select
              items={types}
              value={type}
              disabled={!!field}
              onValueChange={(value) => value && setType(value)}
            >
              <SelectTrigger aria-label={t('catalog.inputFields.type')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t(`catalog.inputFields.typeHints.${type}`)}</FieldDescription>
          </Field>
          <Field invalid={!!errors.labelAr}>
            <FieldLabel>{t('catalog.inputFields.label')}</FieldLabel>
            <Input name="labelAr" defaultValue={field?.labelAr} maxLength={40} autoComplete="off" />
            <FieldError match={!!errors.labelAr}>{errors.labelAr}</FieldError>
          </Field>
          <Field invalid={!!errors.helpAr}>
            <FieldLabel>{t('catalog.inputFields.help')}</FieldLabel>
            <Input
              name="helpAr"
              defaultValue={field?.helpAr ?? ''}
              maxLength={200}
              autoComplete="off"
            />
            <FieldError match={!!errors.helpAr}>{errors.helpAr}</FieldError>
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <label htmlFor={requiredId} className="text-base font-medium">
            {t('catalog.inputFields.required')}
          </label>
          <Switch id={requiredId} checked={required} onCheckedChange={setRequired} />
        </div>
        {BOUNDED.includes(type) && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-4">
              <Field invalid={!!errors.bounds}>
                <FieldLabel>{t('catalog.inputFields.minLength')}</FieldLabel>
                <Input
                  name="minLength"
                  dir="ltr"
                  inputMode="numeric"
                  defaultValue={field?.minLength ?? ''}
                  autoComplete="off"
                />
              </Field>
              <Field invalid={!!errors.bounds}>
                <FieldLabel>{t('catalog.inputFields.maxLength')}</FieldLabel>
                <Input
                  name="maxLength"
                  dir="ltr"
                  inputMode="numeric"
                  defaultValue={field?.maxLength ?? ''}
                  autoComplete="off"
                />
              </Field>
            </div>
            <p className="text-sm text-muted-foreground">
              {t(`catalog.inputFields.boundsHint.${type as 'digits' | 'text'}`)}
            </p>
            {errors.bounds && (
              <p role="alert" className="text-sm text-destructive-text">
                {errors.bounds}
              </p>
            )}
          </div>
        )}
        {type === 'select' && (
          <OptionsEditor options={options} onChange={setOptions} error={errors.options} />
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {field ? t('catalog.actions.save') : t('catalog.inputFields.addSubmit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** A `select` field's 2–50 options: a value (Latin) and its Arabic label each. */
function OptionsEditor({
  options,
  onChange,
  error,
}: {
  options: SelectOption[];
  onChange: (options: SelectOption[]) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const set = (index: number, change: Partial<SelectOption>) =>
    onChange(options.map((option, at) => (at === index ? { ...option, ...change } : option)));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">{t('catalog.inputFields.options')}</legend>
      {options.map((option, index) => (
        // Options have no id until saved; their position names them.
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows are edited in place
        <div key={index} className="flex items-center gap-2">
          <Input
            dir="ltr"
            aria-label={t('catalog.inputFields.optionValue', { position: index + 1 })}
            placeholder={t('catalog.inputFields.optionValuePlaceholder')}
            maxLength={32}
            value={option.value}
            onChange={(event) => set(index, { value: event.target.value })}
          />
          <Input
            aria-label={t('catalog.inputFields.optionLabel', { position: index + 1 })}
            placeholder={t('catalog.inputFields.optionLabelPlaceholder')}
            maxLength={40}
            value={option.labelAr}
            onChange={(event) => set(index, { labelAr: event.target.value })}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('catalog.inputFields.removeOption', { position: index + 1 })}
                  disabled={options.length <= 2}
                  onClick={() => onChange(options.filter((_, at) => at !== index))}
                />
              }
            >
              <Trash2Icon />
            </TooltipTrigger>
            <TooltipContent>
              {t('catalog.inputFields.removeOption', { position: index + 1 })}
            </TooltipContent>
          </Tooltip>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={options.length >= 50}
        onClick={() => onChange([...options, { value: '', labelAr: '' }])}
      >
        <PlusIcon />
        {t('catalog.inputFields.addOption')}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
    </fieldset>
  );
}
