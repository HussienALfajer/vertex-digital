import { useQuery } from '@tanstack/react-query';
import {
  expectedParentListId,
  formatAmountInput,
  formatUsd,
  type LevelTier,
  type MerchantTierView,
  parseUsd,
  ROOT_PRICE_LIST_IDS,
  type TierSettingsInput,
  tierLevelValuesSchema,
  tierSettingsInputSchema,
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
  Switch,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { limitInput, parseLimitInput } from '../customers/customer-labels';
import { Picker } from '../pricing/picker';
import { priceListsQuery } from '../pricing/pricing.queries';
import { useSaveTierSettings, useSetTierLevel } from './merchants.queries';

type LevelField = 'monthlyThresholdUsdUnits' | 'priceListId';

/**
 * TS1 and the levels' rules: a tier's whole-dollar monthly threshold and its list, a priced custom
 * list that inherits from the list of the tier below (wholesale under Silver). The server refuses
 * thresholds out of order and a list off the chain; every merchant is recomputed.
 */
export function TierLevelDialog({
  tier,
  tiers,
  onDone,
}: {
  tier: LevelTier;
  tiers: MerchantTierView[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSetTierLevel(tier);
  const lists = useQuery(priceListsQuery);
  const current = tiers.find((view) => view.tier === tier)?.level ?? null;
  const parentId = expectedParentListId(
    tier,
    tiers.flatMap((view) =>
      view.level && view.tier !== 'bronze' && view.tier !== tier
        ? [{ tier: view.tier, priceListId: view.level.priceList.id }]
        : [],
    ),
    ROOT_PRICE_LIST_IDS.wholesale,
  );
  const parent = lists.data?.find((list) => list.id === parentId);
  const items = (lists.data ?? [])
    .filter(
      (list) =>
        list.id === current?.priceList.id ||
        (list.kind === 'custom' &&
          list.archivedAt === null &&
          list.ready &&
          list.parentListId === parentId),
    )
    .map((list) => ({ value: list.id, label: list.name }));
  const [listId, setListId] = useState<string | null>(current?.priceList.id ?? null);
  const [invalid, setInvalid] = useState<Set<LevelField>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const name = t(`merchants.tierNames.${tier}`);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = tierLevelValuesSchema.safeParse({
      monthlyThresholdUsdUnits:
        parseUsd(String(new FormData(event.currentTarget).get('threshold') ?? '')) ?? undefined,
      priceListId: listId ?? undefined,
    });
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => issue.path[0] as LevelField)));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await save.mutateAsync({ level: parsed.data });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>
          {current
            ? t('merchants.tiers.level.editTitle', { tier: name })
            : t('merchants.tiers.level.addTitle', { tier: name })}
        </DialogTitle>
        <DialogDescription>{t('merchants.tiers.level.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid.has('monthlyThresholdUsdUnits')}>
          <FieldLabel>{t('merchants.tiers.level.threshold')}</FieldLabel>
          <Input
            name="threshold"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={
              current ? formatAmountInput('USD', current.monthlyThresholdUsdUnits) : undefined
            }
          />
          <FieldDescription>{t('merchants.tiers.level.thresholdHint')}</FieldDescription>
          <FieldError match={invalid.has('monthlyThresholdUsdUnits')}>
            {t('merchants.tiers.level.thresholdError')}
          </FieldError>
        </Field>
        <Field invalid={invalid.has('priceListId')}>
          <FieldLabel render={<span />}>{t('merchants.tiers.level.list')}</FieldLabel>
          <Picker
            label={t('merchants.tiers.level.list')}
            placeholder={t('merchants.fields.choose')}
            items={items}
            value={listId}
            onChange={setListId}
            read={lists}
          />
          <FieldDescription>
            {t('merchants.tiers.level.listHint', { parent: parent?.name ?? '—' })}
          </FieldDescription>
          <FieldError match={invalid.has('priceListId')}>
            {t('merchants.tiers.level.listError')}
          </FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <InvalidAlert show={invalid.size > 0} />
          <Button type="submit" disabled={save.isPending}>
            {t('merchants.tiers.level.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

type SettingsField = keyof TierSettingsInput;

/** The typed fields: dollars, whole numbers, or minutes where empty promises no reply time. */
const NUMBERS = [
  { name: 'perDepositUsdUnits', kind: 'money' },
  { name: 'dailyDepositUsdUnits', kind: 'money' },
  { name: 'playerChecksPerHour', kind: 'count' },
  { name: 'playerChecksPerDay', kind: 'count' },
  { name: 'bulkLinesMax', kind: 'count' },
  { name: 'orderUnitsMax', kind: 'count' },
  { name: 'supportReplyMinutes', kind: 'optional' },
] as const satisfies readonly { name: SettingsField; kind: string }[];

type NumberField = (typeof NUMBERS)[number]['name'];

const SWITCHES = [
  'depositPriority',
  'supportPriority',
  'directContact',
  'earlyAccess',
  'fastAlerts',
  'receiptWelcome',
  'receiptLargeLogo',
] as const satisfies readonly SettingsField[];

type SwitchField = (typeof SWITCHES)[number];

function numberInput(kind: string, value: number | null): string {
  if (value === null) return '';
  return kind === 'money' ? limitInput(value) : String(value);
}

function parseNumber(kind: string, text: string): number | null | undefined {
  if (kind === 'money') return parseLimitInput(text) ?? undefined;
  const trimmed = text.trim();
  if (trimmed === '') return kind === 'optional' ? null : undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * TS1, TS2: a tier's privileges: deposit limits (both at least the deposit minimum), player checks,
 * bulk lines and code units per order, the reply promise and the switches. A new version applies
 * at once; per-customer limits still win (TS3).
 */
export function TierSettingsDialog({
  view,
  minDepositUsdUnits,
  onDone,
}: {
  view: MerchantTierView;
  minDepositUsdUnits: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveTierSettings(view.tier);
  const idPrefix = useId();
  const [values, setValues] = useState<Record<NumberField, string>>(
    () =>
      Object.fromEntries(
        NUMBERS.map(({ name, kind }) => [name, numberInput(kind, view.settings[name])]),
      ) as Record<NumberField, string>,
  );
  const [flags, setFlags] = useState<Record<SwitchField, boolean>>(
    () =>
      Object.fromEntries(SWITCHES.map((name) => [name, view.settings[name]])) as Record<
        SwitchField,
        boolean
      >,
  );
  const [invalid, setInvalid] = useState<Set<SettingsField>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const minimum = ltr(formatUsd(minDepositUsdUnits));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = tierSettingsInputSchema.safeParse({
      ...Object.fromEntries(
        NUMBERS.map(({ name, kind }) => [name, parseNumber(kind, values[name])]),
      ),
      ...flags,
    });
    const refused = new Set<SettingsField>(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0] as SettingsField),
    );
    if (parsed.success) {
      for (const field of ['perDepositUsdUnits', 'dailyDepositUsdUnits'] as const) {
        if (parsed.data[field] < minDepositUsdUnits) refused.add(field);
      }
    }
    if (!parsed.success || refused.size > 0) {
      setInvalid(refused);
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await save.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      const paths =
        error instanceof ApiError && Array.isArray(error.details)
          ? (error.details as { path?: unknown[] }[]).map((issue) => issue.path?.[0])
          : [];
      const fields = NUMBERS.map(({ name }) => name).filter((name) => paths.includes(name));
      if (fields.length > 0) {
        setInvalid(new Set(fields));
        return focusInvalid();
      }
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {t('merchants.tiers.settings.title', { tier: t(`merchants.tierNames.${view.tier}`) })}
        </DialogTitle>
        <DialogDescription>{t('merchants.tiers.settings.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          {NUMBERS.map(({ name, kind }) => (
            <Field key={name} invalid={invalid.has(name)}>
              <FieldLabel>{t(`merchants.tiers.settings.fields.${name}`)}</FieldLabel>
              <Input
                name={name}
                dir="ltr"
                inputMode={kind === 'money' ? 'decimal' : 'numeric'}
                autoComplete="off"
                value={values[name]}
                onChange={(event) => {
                  const value = event.target.value;
                  setValues((current) => ({ ...current, [name]: value }));
                }}
              />
              <FieldDescription>
                {t(`merchants.tiers.settings.hints.${name}`, { minimum })}
              </FieldDescription>
              <FieldError match={invalid.has(name)}>
                {t(`merchants.tiers.settings.errors.${name}`, { minimum })}
              </FieldError>
            </Field>
          ))}
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t('merchants.tiers.flags')}</legend>
          {SWITCHES.map((name) => (
            <div
              key={name}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <label htmlFor={`${idPrefix}-${name}`} className="text-sm font-medium">
                {t(`merchants.tiers.settings.fields.${name}`)}
              </label>
              <Switch
                id={`${idPrefix}-${name}`}
                checked={flags[name]}
                onCheckedChange={(checked) =>
                  setFlags((current) => ({ ...current, [name]: checked }))
                }
              />
            </div>
          ))}
        </fieldset>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <InvalidAlert show={invalid.size > 0} />
          <Button type="submit" disabled={save.isPending}>
            {t('merchants.tiers.settings.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
