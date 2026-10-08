import { Link } from '@tanstack/react-router';
import {
  type AdminDeposit,
  APPROVAL_FLAG_CODES,
  type ApproveDeposit,
  approvalFlags,
  approvalNeedsReauthentication,
  approveDepositSchema,
  CURRENCIES,
  type Currency,
  DEPOSIT_REFERENCE_CHECKS,
  type DepositFlagCode,
  type DepositReferenceCheck,
  depositCreditUsdUnits,
  formatAmountInput,
  formatRate,
  formatUsd,
  parseUsd,
  parseWholeSyp,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  CardTitle,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from '@vertex-digital/ui';
import { ShieldCheckIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useApproveDeposit } from './deposits.queries';

type ApproveField = 'transaction' | 'amount' | 'reference' | 'flags';

/** The typed amount in units of its currency, or null when it is not a whole amount. */
export function parseAmount(currency: Currency, text: string): number | null {
  return currency === 'SYP' ? parseWholeSyp(text) : parseUsd(text);
}

/**
 * The approval (rules RV1–RV5): the Sham Cash transaction number seen in the store's own account,
 * what was received, the reference check, the credit computed live (RV2, at the rate of RV3), and
 * every flag ticked, the approval-time ones as they appear (RV5). The API asks for
 * re-authentication when RV4 requires it; the retry keeps the `Idempotency-Key`.
 */
export function ApproveForm({ deposit, onDone }: { deposit: AdminDeposit; onDone: () => void }) {
  const { t } = useTranslation();
  const approve = useApproveDeposit(deposit.id);
  const keyFor = useIdempotencyKey();
  const [transaction, setTransaction] = useState('');
  const [currency, setCurrency] = useState<Currency>(deposit.currency);
  const [amount, setAmount] = useState(
    formatAmountInput(deposit.currency, deposit.declaredAmountUnits),
  );
  const [referenceCheck, setReferenceCheck] = useState<DepositReferenceCheck | null>(null);
  const [ticked, setTicked] = useState<DepositFlagCode[]>([]);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<ApproveField, string>>>({});
  const [failure, setFailure] = useState<{ message: string; holder?: unknown } | null>(null);

  const receivedUnits = parseAmount(currency, amount);
  const rate = currency === 'SYP' ? (deposit.approvalRate?.rate ?? null) : null;
  const missingRate = currency === 'SYP' && rate === null;
  const credit =
    receivedUnits === null || receivedUnits <= 0 || missingRate
      ? null
      : depositCreditUsdUnits(currency, receivedUnits, rate);
  const submissionFlags = [...new Set(deposit.flags.map((flag) => flag.code))];
  const atApproval =
    receivedUnits !== null && referenceCheck
      ? approvalFlags(deposit, {
          receivedCurrency: currency,
          receivedAmountUnits: receivedUnits,
          referenceCheck,
        }).filter((code) => !submissionFlags.includes(code))
      : [];
  const allFlags = [...submissionFlags, ...atApproval];
  const reauthentication =
    credit !== null && approvalNeedsReauthentication(credit, allFlags.length);

  /**
   * Rule RV5: an approval-time flag is acknowledged for the values it was raised on. A change to
   * what was received or to the reference check clears those ticks, so a flag that comes back is
   * read again.
   */
  const clearApprovalTicks = () =>
    setTicked((previous) =>
      previous.filter((code) => !(APPROVAL_FLAG_CODES as readonly string[]).includes(code)),
    );

  function changeCurrency(next: Currency) {
    clearApprovalTicks();
    setCurrency(next);
    // The declared amount is the useful start in its own currency only.
    setAmount(
      next === deposit.currency ? formatAmountInput(next, deposit.declaredAmountUnits) : '',
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const found: Partial<Record<ApproveField, string>> = {};
    const body: ApproveDeposit = {
      transactionNumber: transaction,
      receivedCurrency: currency,
      receivedAmountUnits: receivedUnits ?? Number.NaN,
      referenceCheck: referenceCheck ?? ('' as DepositReferenceCheck),
      acknowledgedFlags: ticked.filter((code) => allFlags.includes(code)),
      internalNote: note.trim() || undefined,
    };
    const parsed = approveDepositSchema.safeParse(body);
    for (const issue of parsed.error?.issues ?? []) {
      if (issue.path[0] === 'transactionNumber') {
        found.transaction = t('deposits.approve.errors.transaction');
      }
      if (issue.path[0] === 'receivedAmountUnits') {
        found.amount = t(`deposits.approve.errors.amount${currency}`);
      }
      if (issue.path[0] === 'referenceCheck') {
        found.reference = t('deposits.approve.errors.reference');
      }
    }
    if (!found.amount && (credit === null || credit === 0)) {
      found.amount = missingRate
        ? t('deposits.approve.errors.noRate')
        : t('deposits.approve.errors.zeroCredit');
    }
    if (allFlags.some((code) => !ticked.includes(code))) {
      found.flags = t('deposits.approve.errors.flags');
    }
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return;
    try {
      await approve.mutateAsync({ body: parsed.data, key: keyFor(parsed.data) });
      onDone();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === 'EXTERNAL_REFERENCE_TAKEN') {
        setErrors({ transaction: errorMessage(t, error) });
        setFailure({ message: '', holder: (error as ApiError).details });
      } else if (code === 'FLAGS_NOT_ACKNOWLEDGED') {
        setErrors({ flags: errorMessage(t, error) });
      } else {
        setFailure({ message: errorMessage(t, error) });
      }
    }
  }

  return (
    <Card className="gap-4">
      <CardTitle>{t('deposits.approve.title')}</CardTitle>
      <p className="flex items-start gap-2 rounded-md bg-status-info p-3 text-sm text-status-info-foreground">
        <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t('deposits.approve.verify')}
      </p>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.transaction}>
          <FieldLabel>{t('deposits.approve.transaction')}</FieldLabel>
          <Input
            name="transactionNumber"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={transaction}
            onChange={(event) => setTransaction(event.target.value)}
          />
          <FieldDescription>{t('deposits.approve.transactionHint')}</FieldDescription>
          <FieldError match={!!errors.transaction}>{errors.transaction}</FieldError>
          <ReferenceHolder holder={failure?.holder} />
        </Field>
        <Field>
          <FieldLabel>{t('deposits.approve.currency')}</FieldLabel>
          <ToggleGroup<Currency>
            aria-label={t('deposits.approve.currency')}
            value={[currency]}
            onValueChange={(value) => value[0] && changeCurrency(value[0])}
          >
            {CURRENCIES.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`deposits.currencies.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field invalid={!!errors.amount}>
          <FieldLabel>{t(`deposits.approve.amount${currency}`)}</FieldLabel>
          <Input
            name="receivedAmount"
            dir="ltr"
            inputMode={currency === 'SYP' ? 'numeric' : 'decimal'}
            autoComplete="off"
            value={amount}
            onChange={(event) => {
              clearApprovalTicks();
              setAmount(event.target.value);
            }}
          />
          {currency === 'SYP' && rate && (
            <FieldDescription>
              {t('deposits.approve.rateHint', { rate: formatRate(rate) })}
            </FieldDescription>
          )}
          <FieldError match={!!errors.amount}>{errors.amount}</FieldError>
        </Field>
        <Field invalid={!!errors.reference}>
          <FieldLabel>{t('deposits.approve.reference')}</FieldLabel>
          <ToggleGroup<DepositReferenceCheck>
            aria-label={t('deposits.approve.reference')}
            value={referenceCheck ? [referenceCheck] : []}
            onValueChange={(value) => {
              clearApprovalTicks();
              setReferenceCheck(value[0] ?? null);
            }}
          >
            {DEPOSIT_REFERENCE_CHECKS.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`deposits.referenceChecks.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>
            {t('deposits.approve.referenceHint', { reference: deposit.referenceCode })}
          </FieldDescription>
          <FieldError match={!!errors.reference}>{errors.reference}</FieldError>
        </Field>
        <dl className="flex flex-col gap-1 rounded-lg border border-border p-3">
          <dt className="text-sm text-muted-foreground">{t('deposits.approve.credit')}</dt>
          <dd className="text-2xl font-bold tabular-nums">
            <bdi dir="ltr">{credit === null ? '—' : formatUsd(credit)}</bdi>
          </dd>
        </dl>
        {allFlags.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('deposits.approve.flags')}</legend>
            {allFlags.map((code) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control.
              <label key={code} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={ticked.includes(code)}
                  onCheckedChange={(checked) =>
                    setTicked((previous) =>
                      checked ? [...previous, code] : previous.filter((item) => item !== code),
                    )
                  }
                />
                <span>
                  <span className="font-medium">{t(`deposits.flags.${code}.label`)}</span>
                  {' — '}
                  {t(`deposits.flags.${code}.description`)}
                </span>
              </label>
            ))}
            {errors.flags && (
              <p role="alert" className="text-sm text-destructive-text">
                {errors.flags}
              </p>
            )}
          </fieldset>
        )}
        <Field>
          <FieldLabel>{t('deposits.approve.note')}</FieldLabel>
          <Textarea
            name="internalNote"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldDescription>{t('deposits.approve.noteHint')}</FieldDescription>
        </Field>
        {reauthentication && (
          <p className="text-sm text-muted-foreground">{t('deposits.approve.reauthentication')}</p>
        )}
        {failure?.message && <FormAlert>{failure.message}</FormAlert>}
        <Button type="submit" className="self-start" disabled={approve.isPending}>
          {approve.isPending
            ? t('deposits.approve.submitting')
            : credit
              ? t('deposits.approve.submit', { amount: ltr(formatUsd(credit)) })
              : t('deposits.approve.submitEmpty')}
        </Button>
      </form>
    </Card>
  );
}

/** Rule SC14: who already claimed the transaction number, shown to the admin only. */
function ReferenceHolder({ holder }: { holder: unknown }) {
  const { t } = useTranslation();
  const owner = holder as { kind?: unknown; id?: unknown } | undefined;
  if (typeof owner?.id !== 'string') return null;
  if (owner.kind === 'deposit') {
    return (
      <Link
        to="/deposits/$id"
        params={{ id: owner.id }}
        className="w-fit rounded-sm text-sm underline underline-offset-4"
      >
        {t('deposits.approve.takenByDeposit')}
      </Link>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {t('deposits.approve.takenByAdjustment')} <code dir="ltr">{owner.id}</code>
    </p>
  );
}
