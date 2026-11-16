import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  createRateSourceSchema,
  RATE_SOURCE_KINDS,
  RATE_SOURCE_UNITS,
  type RateSource,
  type RateSourceKind,
  type RateSourceTestResult,
  testRateSourceSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  CardTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArchiveIcon, ArrowRightIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ReadLine } from './rate-automation';
import {
  rateSourcesQuery,
  useArchiveRateSource,
  useCreateRateSource,
  useTestRateSource,
  useUpdateRateSource,
} from './rates.queries';

/** The word a new source of each kind reads after (sp-today labels its column «بيع»). */
const SELL_WORDS: Record<RateSourceKind, string> = {
  telegram_channel: 'مبيع',
  sp_today_page: 'بيع',
};

type SourceField = 'label' | 'handle' | 'cityWord' | 'sellWord';

/**
 * S27 "/rates/sources/new" and the edit page: kind, label, channel or page, city word, sell word
 * and unit, with "تجربة القراءة" showing the figure and the matched line before saving.
 */
export function RateSourcePage({ id }: { id?: string }) {
  const { t } = useTranslation();
  const sources = useQuery({ ...rateSourcesQuery, enabled: id !== undefined });
  const source = id ? sources.data?.items.find((item) => item.id === id) : undefined;
  return (
    <>
      <PageHeader
        title={t(id ? 'rates.sourceForm.editTitle' : 'rates.sourceForm.newTitle')}
        description={t('rates.sourceForm.subtitle')}
        actions={
          <Button variant="ghost" render={<Link to="/rates" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" aria-hidden="true" />
            {t('rates.sourceForm.back')}
          </Button>
        }
      />
      {id && sources.isPending && <Skeleton className="h-96 w-full" aria-hidden="true" />}
      {id && sources.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, sources.error)}</FormAlert>
          <Button variant="outline" onClick={() => sources.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {id && sources.isSuccess && !source && <FormAlert>{t('rates.sourceForm.missing')}</FormAlert>}
      {(!id || source) && <SourceForm source={source} />}
    </>
  );
}

function SourceForm({ source }: { source?: RateSource }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateRateSource();
  const update = useUpdateRateSource();
  const test = useTestRateSource();
  const [kind, setKind] = useState<RateSourceKind>(source?.kind ?? 'telegram_channel');
  const [label, setLabel] = useState(source?.label ?? '');
  const [handle, setHandle] = useState(source?.handle ?? '');
  const [cityWord, setCityWord] = useState(source?.parser.cityWord ?? '');
  const [sellWord, setSellWord] = useState(source?.parser.sellWord ?? SELL_WORDS[kind]);
  const [unit, setUnit] = useState(source?.parser.unit ?? 'new_syp');
  const [errors, setErrors] = useState<Partial<Record<SourceField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<RateSourceTestResult | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archive = useArchiveRateSource();
  const { ref, focusInvalid } = useFocusInvalid();

  const target = () => ({
    kind,
    handle: handle.trim().replace(/^@/, ''),
    parser: { cityWord: cityWord.trim() || null, sellWord: sellWord.trim(), unit },
  });

  /** Field errors of a body, by the contract (the handle checked against the kind). */
  function check(
    body: unknown,
    schema: typeof createRateSourceSchema | typeof testRateSourceSchema,
  ) {
    const found: Partial<Record<SourceField, string>> = {};
    for (const issue of schema.safeParse(body).error?.issues ?? []) {
      const [first, second] = issue.path;
      if (first === 'label') found.label = t('rates.sourceForm.errors.label');
      if (first === 'handle') found.handle = t(`rates.sourceForm.errors.handle.${kind}`);
      if (first === 'parser' && second === 'cityWord')
        found.cityWord = t('rates.sourceForm.errors.word');
      if (first === 'parser' && second === 'sellWord')
        found.sellWord = t('rates.sourceForm.errors.word');
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function runTest() {
    setFailure(null);
    setResult(null);
    const body = target();
    if (!check(body, testRateSourceSchema)) return focusInvalid();
    try {
      setResult(await test.mutateAsync(testRateSourceSchema.parse(body)));
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const body = { ...target(), label: label.trim(), enabled: source?.enabled ?? true };
    if (!check(body, createRateSourceSchema)) return focusInvalid();
    try {
      if (source) {
        const { kind: _kind, enabled: _enabled, ...changes } = body;
        await update.mutateAsync({ id: source.id, body: changes });
      } else {
        await create.mutateAsync(createRateSourceSchema.parse(body));
      }
      await navigate({ to: '/rates' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RATE_SOURCE_INVALID') {
        setErrors({ handle: errorMessage(t, error) });
        return focusInvalid();
      }
      setFailure(errorMessage(t, error));
    }
  }

  const saving = create.isPending || update.isPending;
  const kindItems = RATE_SOURCE_KINDS.map((value) => ({ value, label: t(`rates.kinds.${value}`) }));
  const unitItems = RATE_SOURCE_UNITS.map((value) => ({ value, label: t(`rates.units.${value}`) }));
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card className="gap-4">
        <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <Field>
            <FieldLabel>{t('rates.sourceForm.kind')}</FieldLabel>
            <Select
              items={kindItems}
              value={kind}
              disabled={source !== undefined}
              onValueChange={(next) => {
                if (!next) return;
                const nextKind = next as RateSourceKind;
                if (sellWord.trim() === SELL_WORDS[kind]) setSellWord(SELL_WORDS[nextKind]);
                setKind(nextKind);
                setResult(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kindItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t(`rates.sourceForm.kindHint.${kind}`)}</FieldDescription>
          </Field>
          <Field invalid={!!errors.label}>
            <FieldLabel>{t('rates.sourceForm.label')}</FieldLabel>
            <Input name="label" value={label} onChange={(event) => setLabel(event.target.value)} />
            <FieldDescription>{t('rates.sourceForm.labelHint')}</FieldDescription>
            <FieldError match={!!errors.label}>{errors.label}</FieldError>
          </Field>
          <Field invalid={!!errors.handle}>
            <FieldLabel>{t(`rates.sourceForm.handle.${kind}`)}</FieldLabel>
            <Input
              name="handle"
              dir="ltr"
              autoComplete="off"
              value={handle}
              onChange={(event) => {
                setHandle(event.target.value);
                setResult(null);
              }}
            />
            <FieldDescription>{t(`rates.sourceForm.handleHint.${kind}`)}</FieldDescription>
            <FieldError match={!!errors.handle}>{errors.handle}</FieldError>
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field invalid={!!errors.cityWord}>
              <FieldLabel>{t('rates.sourceForm.cityWord')}</FieldLabel>
              <Input
                name="cityWord"
                value={cityWord}
                onChange={(event) => setCityWord(event.target.value)}
              />
              <FieldDescription>{t('rates.sourceForm.cityWordHint')}</FieldDescription>
              <FieldError match={!!errors.cityWord}>{errors.cityWord}</FieldError>
            </Field>
            <Field invalid={!!errors.sellWord}>
              <FieldLabel>{t('rates.sourceForm.sellWord')}</FieldLabel>
              <Input
                name="sellWord"
                value={sellWord}
                onChange={(event) => setSellWord(event.target.value)}
              />
              <FieldDescription>{t('rates.sourceForm.sellWordHint')}</FieldDescription>
              <FieldError match={!!errors.sellWord}>{errors.sellWord}</FieldError>
            </Field>
          </div>
          <Field>
            <FieldLabel>{t('rates.sourceForm.unit')}</FieldLabel>
            <Select
              items={unitItems}
              value={unit}
              onValueChange={(next) => next && setUnit(next as typeof unit)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {unitItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {failure && <FormAlert>{failure}</FormAlert>}
          <InvalidAlert show={Object.values(errors).some(Boolean)} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? t('rates.form.submitting') : t('rates.sourceForm.save')}
            </Button>
            <Button type="button" variant="outline" disabled={test.isPending} onClick={runTest}>
              {test.isPending ? t('rates.sourceForm.testing') : t('rates.sourceForm.test')}
            </Button>
            {source && (
              <Button type="button" variant="ghost" onClick={() => setArchiving(true)}>
                <ArchiveIcon aria-hidden="true" />
                {t('rates.sourceForm.archive')}
              </Button>
            )}
          </div>
        </form>
      </Card>
      <Card className="gap-3 self-start">
        <CardTitle>{t('rates.sourceForm.testTitle')}</CardTitle>
        {result ? (
          <ul className="flex flex-col gap-2 text-sm" aria-live="polite">
            <ReadLine read={result} />
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('rates.sourceForm.testHint')}</p>
        )}
      </Card>
      {source && (
        <ConfirmDialog
          open={archiving}
          onClose={() => setArchiving(false)}
          title={t('rates.sourceForm.archiveTitle')}
          body={t('rates.sourceForm.archiveBody', { label: source.label })}
          action={t('rates.sourceForm.archive')}
          destructive
          pending={archive.isPending}
          onConfirm={async () => {
            await archive.mutateAsync(source.id);
            await navigate({ to: '/rates' });
          }}
        />
      )}
    </div>
  );
}
