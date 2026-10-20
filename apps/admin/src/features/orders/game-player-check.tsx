import { useQuery } from '@tanstack/react-query';
import {
  type CheckCategory,
  type GameDetail,
  type GamePlayerCheck,
  MAX_ALLOWED_REGIONS,
  type OptionMap,
  type PlayerCheck,
  playerRegionSchema,
  type SupplierCode,
  unmappedFields,
  unmappedOptions,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
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
  Skeleton,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { fieldMapEntries, proposedFieldMap, toFieldMap } from '../suppliers/field-map';
import { FieldMapEditor } from '../suppliers/field-map-editor';
import { gameSelects, OptionMapEditor, supplierSelects } from '../suppliers/option-map-editor';
import { checkCategoriesQuery, suppliersQuery } from '../suppliers/suppliers.queries';
import { gamePlayerCheckQuery, useAdminPlayerCheck, useSetGamePlayerCheck } from './orders.queries';
import { PlayerCheckAnswer } from './player-check-answer';

/**
 * The game page's "فحص اللاعب" card (S19 PC1–PC3): the provider that checks every `direct` pack
 * of the game whichever supplier fulfils it, its check category (searchable), the map of the
 * provider's fields onto the game's (proposed by key), the allowed regions and the switch; then
 * "تجربة", the admin check (AP8) of the saved row with typed values.
 */
export function GamePlayerCheckCard({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const state = useQuery(gamePlayerCheckQuery(game.id));
  const suppliers = useQuery(suppliersQuery);
  return (
    <Card className="gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="flex flex-wrap items-center gap-2 font-bold">
          {t('orders.gameCheck.title')}
          {state.data?.check?.enabled && <Badge tone="success">{t('orders.gameCheck.on')}</Badge>}
        </h3>
        <p className="text-sm text-muted-foreground">{t('orders.gameCheck.hint')}</p>
      </div>
      {state.isPending || suppliers.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : state.isError || suppliers.isError ? (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, state.error ?? suppliers.error)}</FormAlert>
          <Button
            variant="outline"
            onClick={() => {
              void state.refetch();
              void suppliers.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <CheckForm
          // Kept across saves: the form already holds what the API stored, and its notice stays.
          key={game.id}
          game={game}
          check={state.data.check}
          providers={suppliers.data
            .filter((supplier) => supplier.available && supplier.canValidatePlayer)
            .map((supplier) => ({ code: supplier.code, nameAr: supplier.nameAr }))}
        />
      )}
    </Card>
  );
}

type Problem = 'supplier' | 'category' | 'fields' | 'regions';

function CheckForm({
  game,
  check,
  providers,
}: {
  game: GameDetail;
  check: GamePlayerCheck | null;
  providers: { code: SupplierCode; nameAr: string }[];
}) {
  const { t } = useTranslation();
  const enabledId = useId();
  const live = game.fields.filter((field) => field.archivedAt === null);
  const gameKeys = live.map((field) => field.key);
  const [code, setCode] = useState<SupplierCode | null>(
    check?.supplierCode ?? (providers.length === 1 ? (providers[0]?.code ?? null) : null),
  );
  const [categoryId, setCategoryId] = useState(check?.categoryId ?? '');
  const [map, setMap] = useState<Record<string, string>>(check?.fieldMap ?? {});
  const [optionMap, setOptionMap] = useState<OptionMap>(check?.optionMap ?? {});
  const [regions, setRegions] = useState<string[]>(check?.allowedRegions ?? []);
  const [enabled, setEnabled] = useState(check?.enabled ?? true);
  const [filter, setFilter] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useSetGamePlayerCheck(game.id);
  const { ref, focusInvalid } = useFocusInvalid<HTMLDivElement>();
  const categories = useQuery({ ...checkCategoriesQuery(code ?? 'fake'), enabled: code !== null });
  const category = categories.data?.items.find((item) => item.categoryId === categoryId) ?? null;
  const theirKeys = category ? category.fields.map((field) => field.key) : Object.keys(map);
  const unmapped = unmappedFields(theirKeys, map);
  const optionsMissing = category
    ? unmappedOptions(category.fields, map, optionMap, gameSelects(live))
    : [];
  const typed = filter.trim().toLowerCase();
  const shown = (categories.data?.items ?? []).filter(
    (item) =>
      item.categoryId === categoryId ||
      typed === '' ||
      item.name.toLowerCase().includes(typed) ||
      item.categoryId.toLowerCase().includes(typed),
  );

  function edited() {
    setSaved(false);
    setFailure(null);
  }

  function chooseCategory(next: CheckCategory) {
    const keys = next.fields.map((field) => field.key);
    setCategoryId(next.categoryId);
    setMap(proposedFieldMap(keys, gameKeys));
    setOptionMap({});
    setProblems([]);
    edited();
  }

  async function submit() {
    edited();
    // A disabled row is kept as it is typed (the API reads no category for it).
    const next: Problem[] = [];
    if (!code) next.push('supplier');
    if (!categoryId) next.push('category');
    if (enabled && (unmapped.length > 0 || optionsMissing.length > 0)) next.push('fields');
    setProblems(next);
    if (!code || next.length > 0) return focusInvalid();
    try {
      await save.mutateAsync({
        supplierCode: code,
        categoryId,
        fieldMap: map,
        optionMap,
        allowedRegions: regions,
        enabled,
      });
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
      if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        const paths = Array.isArray(error.details)
          ? (error.details as { path?: unknown[] }[]).map((issue) => issue.path?.[0])
          : [];
        setProblems([paths.includes('categoryId') ? 'category' : 'fields']);
        focusInvalid();
      }
    }
  }

  if (providers.length === 0 && !check) {
    return <p className="text-sm text-muted-foreground">{t('orders.gameCheck.noProvider')}</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      <div ref={ref} className="flex flex-col gap-4">
        <Field invalid={problems.includes('supplier')}>
          <FieldLabel>{t('orders.gameCheck.provider')}</FieldLabel>
          <Select
            items={providers.map((provider) => ({ value: provider.code, label: provider.nameAr }))}
            value={code}
            onValueChange={(value) => {
              setCode(value as SupplierCode);
              setCategoryId('');
              setMap({});
              setOptionMap({});
              setProblems([]);
              edited();
            }}
          >
            <SelectTrigger aria-invalid={problems.includes('supplier') || undefined}>
              <SelectValue placeholder={t('orders.gameCheck.chooseProvider')} />
            </SelectTrigger>
            <SelectContent>
              {providers.map((provider) => (
                <SelectItem key={provider.code} value={provider.code}>
                  {provider.nameAr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError match={problems.includes('supplier')}>
            {t('orders.gameCheck.errors.supplier')}
          </FieldError>
        </Field>
        {code && (
          <Field invalid={problems.includes('category')}>
            <FieldLabel>{t('orders.gameCheck.category')}</FieldLabel>
            {categories.isPending ? (
              <Skeleton className="h-10 w-full" />
            ) : categories.isError ? (
              <div className="flex flex-col items-start gap-2">
                <FormAlert>{errorMessage(t, categories.error)}</FormAlert>
                <Button variant="outline" size="sm" onClick={() => categories.refetch()}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Input
                  value={filter}
                  autoComplete="off"
                  aria-label={t('orders.gameCheck.search')}
                  placeholder={t('orders.gameCheck.search')}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <Select
                  items={shown.map((item) => ({ value: item.categoryId, label: item.name }))}
                  value={categoryId || null}
                  onValueChange={(value) => {
                    const next = categories.data.items.find((item) => item.categoryId === value);
                    if (next) chooseCategory(next);
                  }}
                >
                  <SelectTrigger aria-invalid={problems.includes('category') || undefined}>
                    <SelectValue placeholder={t('orders.gameCheck.chooseCategory')} />
                  </SelectTrigger>
                  <SelectContent>
                    {shown.map((item) => (
                      <SelectItem key={item.categoryId} value={item.categoryId}>
                        <span className="flex flex-col">
                          <bdi>{item.name}</bdi>
                          <bdi dir="ltr" className="text-xs text-muted-foreground">
                            {item.categoryId}
                          </bdi>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {shown.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('orders.gameCheck.noMatch')}</p>
                )}
                {categoryId && !category && (
                  <FormAlert>{t('orders.gameCheck.categoryGone')}</FormAlert>
                )}
              </div>
            )}
            <FieldError match={problems.includes('category')}>
              {t('orders.gameCheck.errors.category')}
            </FieldError>
          </Field>
        )}
        {categoryId && (
          <>
            <FieldMapEditor
              entries={fieldMapEntries(theirKeys, map)}
              fields={live}
              missing={problems.includes('fields') ? unmapped : []}
              extendable={false}
              onChange={(entries) => {
                setMap(toFieldMap(entries));
                edited();
              }}
            />
            {category && (
              <OptionMapEditor
                fieldMap={map}
                fields={live}
                supplierOptions={supplierSelects(category.fields)}
                optionMap={optionMap}
                missing={problems.includes('fields') ? optionsMissing : []}
                onChange={(next) => {
                  setOptionMap(next);
                  edited();
                }}
              />
            )}
          </>
        )}
        <RegionsField
          regions={regions}
          onChange={(next) => {
            setRegions(next);
            edited();
          }}
        />
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <label htmlFor={enabledId} className="flex flex-col gap-0.5">
            <span className="text-base font-medium">{t('orders.gameCheck.enabled')}</span>
            <span className="text-sm text-muted-foreground">
              {t('orders.gameCheck.enabledHint')}
            </span>
          </label>
          <Switch
            id={enabledId}
            checked={enabled}
            onCheckedChange={(next) => {
              setEnabled(next);
              edited();
            }}
          />
        </div>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('orders.gameCheck.saved')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={save.isPending} onClick={submit}>
          {save.isPending ? t('orders.gameCheck.saving') : t('orders.gameCheck.save')}
        </Button>
        <InvalidAlert show={problems.length > 0} />
      </div>
      {check?.enabled && <TrialCheck game={game} />}
    </div>
  );
}

/** The allowed regions as chips (PC3): typed, upper-cased, checked as the API checks them. */
function RegionsField({
  regions,
  onChange,
}: {
  regions: string[];
  onChange: (regions: string[]) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [refusal, setRefusal] = useState<'invalid' | 'duplicate' | null>(null);

  function add(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Enter adds a chip; it never saves the card.
    event.preventDefault();
    const parsed = playerRegionSchema.safeParse(typed);
    if (!parsed.success) return setRefusal('invalid');
    if (regions.includes(parsed.data)) return setRefusal('duplicate');
    onChange([...regions, parsed.data]);
    setTyped('');
    setRefusal(null);
  }

  return (
    <Field invalid={refusal !== null}>
      <FieldLabel>{t('orders.gameCheck.regions')}</FieldLabel>
      {regions.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('orders.gameCheck.regionList')}>
          {regions.map((region) => (
            <li key={region}>
              <Badge tone="outline" className="h-8 gap-1 pe-1 text-sm">
                <bdi dir="ltr">{region}</bdi>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6"
                        aria-label={t('orders.gameCheck.removeRegion', { region })}
                        onClick={() => onChange(regions.filter((other) => other !== region))}
                      />
                    }
                  >
                    <XIcon />
                  </TooltipTrigger>
                  <TooltipContent>{t('orders.gameCheck.removeRegion', { region })}</TooltipContent>
                </Tooltip>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        value={typed}
        maxLength={16}
        autoComplete="off"
        placeholder={t('orders.gameCheck.regionPlaceholder')}
        disabled={regions.length >= MAX_ALLOWED_REGIONS}
        onChange={(event) => {
          setTyped(event.target.value);
          setRefusal(null);
        }}
        onKeyDown={add}
      />
      <FieldDescription>
        {regions.length === 0
          ? t('orders.gameCheck.regionsNone')
          : t('orders.gameCheck.regionsHint')}
      </FieldDescription>
      <FieldError match={refusal !== null}>
        {refusal && t(`orders.gameCheck.regionRefused.${refusal}`)}
      </FieldError>
    </Field>
  );
}

/** "تجربة" (AP8): the saved row checks typed values for a `direct` pack of the game. */
function TrialCheck({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const live = game.fields.filter((field) => field.archivedAt === null);
  const product = game.products.find((item) => item.kind === 'direct' && item.archivedAt === null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState<PlayerCheck | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const check = useAdminPlayerCheck();
  if (!product) {
    return <p className="text-sm text-muted-foreground">{t('orders.gameCheck.trialNoPack')}</p>;
  }

  async function run(productId: string) {
    setAnswer(null);
    setFailure(null);
    try {
      setAnswer(await check.mutateAsync({ productId, fields: values }));
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{t('orders.gameCheck.trial')}</span>
        <span className="text-sm text-muted-foreground">{t('orders.gameCheck.trialHint')}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {live.map((field) => (
          <Field key={field.key}>
            <FieldLabel>{field.labelAr}</FieldLabel>
            {field.options ? (
              <Select
                items={field.options.map((option) => ({
                  value: option.value,
                  label: option.labelAr,
                }))}
                value={values[field.key] ?? null}
                onValueChange={(value) =>
                  setValues((current) => ({ ...current, [field.key]: String(value ?? '') }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('orders.gameCheck.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.labelAr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                dir="ltr"
                autoComplete="off"
                value={values[field.key] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            )}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={check.isPending} onClick={() => run(product.id)}>
          {check.isPending ? t('orders.buy.checking') : t('orders.gameCheck.trialRun')}
        </Button>
        {answer && <PlayerCheckAnswer check={answer} />}
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
    </div>
  );
}
