import {
  CURRENCIES,
  type Currency,
  parseUsd,
  parseWholeSyp,
  type ReconciliationRunDetail,
  type ShamCashCount,
  shamCashCountSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
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
  ToggleGroup,
  ToggleGroupItem,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useShamCashCount } from './reconciliation.queries';
import { money, RESULT_TONES, resultStatusLabel } from './reconciliation-labels';

/**
 * "جرد الرصيد" (rules RN6, E4): the currency and the balance typed from the Sham Cash app. The
 * books are shown only after saving, so the count is not anchored on them.
 */
export function CountDialog({
  currency: initial,
  onDone,
}: {
  currency: Currency;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const count = useShamCashCount();
  const keyFor = useIdempotencyKey();
  const [currency, setCurrency] = useState<Currency>(initial);
  const [amountText, setAmountText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReconciliationRunDetail | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const units = currency === 'SYP' ? parseWholeSyp(amountText) : parseUsd(amountText);
    const parsed = shamCashCountSchema.safeParse({ currency, countedUnits: units ?? Number.NaN });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    const body: ShamCashCount = parsed.data;
    try {
      setSaved(await count.mutateAsync({ body, key: keyFor(body) }));
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const result = saved?.results[0];
  if (saved && result) {
    return (
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('reconciliation.count.savedTitle')}</DialogTitle>
          <DialogDescription>{t('reconciliation.count.savedDescription')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-sm">
          <Fact label={t('reconciliation.columns.actual')}>
            {result.actualUnits !== null ? money(t, currency, result.actualUnits) : '—'}
          </Fact>
          <Fact label={t('reconciliation.columns.books')}>
            {result.booksUnits !== null ? money(t, currency, result.booksUnits) : '—'}
          </Fact>
          <Fact label={t('reconciliation.columns.difference')}>
            {result.differenceUnits !== null ? money(t, currency, result.differenceUnits) : '—'}
          </Fact>
          <Fact label={t('reconciliation.columns.result')}>
            <Badge tone={RESULT_TONES[result.status]}>{resultStatusLabel(t, result)}</Badge>
          </Fact>
        </dl>
        <DialogFooter>
          <Button onClick={onDone}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('reconciliation.count.title')}</DialogTitle>
        <DialogDescription>{t('reconciliation.count.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field>
          <FieldLabel>{t('reconciliation.count.currency')}</FieldLabel>
          <ToggleGroup<Currency>
            aria-label={t('reconciliation.count.currency')}
            value={[currency]}
            onValueChange={(value) => value[0] && setCurrency(value[0])}
          >
            {CURRENCIES.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`reconciliation.currencies.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field invalid={invalid}>
          <FieldLabel>{t('reconciliation.count.amount')}</FieldLabel>
          <Input
            name="counted"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
          />
          <FieldDescription>{t(`reconciliation.count.hints.${currency}`)}</FieldDescription>
          <FieldError match={invalid}>{t(`reconciliation.count.errors.${currency}`)}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={count.isPending}>
            {count.isPending ? t('reconciliation.saving') : t('reconciliation.count.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{children}</dd>
    </div>
  );
}
