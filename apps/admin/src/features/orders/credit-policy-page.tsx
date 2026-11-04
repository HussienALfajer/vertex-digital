import { useQuery } from '@tanstack/react-query';
import {
  CREDIT_POLICY_DEFAULTS,
  type CreditPolicy,
  creditPolicySchema,
  formatAmountInput,
  formatUsd,
  parseUsd,
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
  Skeleton,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { creditPolicyQuery, useSetCreditPolicy } from './orders.queries';

type PolicyField = keyof CreditPolicy;

/** The form's sections, in order (S25 CL2–CL4, CS1–CS5). */
const SECTIONS: { title: 'section' | 'recipients' | 'cash' | 'hold'; fields: PolicyField[] }[] = [
  { title: 'section', fields: ['retailDailyUsdUnits', 'merchantDailyUsdUnits'] },
  {
    title: 'recipients',
    fields: [
      'recipientDailyOrdersRetail',
      'recipientDailyOrdersMerchant',
      'recipientAccountsAlert',
      'recipientAlertDays',
    ],
  },
  {
    title: 'cash',
    fields: ['cashRetailDailyUsdUnits', 'cashMerchantDailyUsdUnits', 'cashBalanceAgeHours'],
  },
  {
    title: 'hold',
    fields: [
      'cashRetailApprovalAboveUsdUnits',
      'cashMerchantApprovalAboveUsdUnits',
      'cashTelegramCeilingUsdUnits',
      'cashHoldHours',
    ],
  },
];

/** Amounts are typed in dollars and sent as USD units (ADR 0003); the rest are whole numbers. */
const isDollars = (field: PolicyField) => field.endsWith('UsdUnits');

const WHOLE = /^\d{1,5}$/;

const textOf = (field: PolicyField, value: number) =>
  isDollars(field) ? formatAmountInput('USD', value) : String(value);

const parsedValue = (field: PolicyField, text: string) =>
  isDollars(field) ? parseUsd(text) : WHOLE.test(text) ? Number(text) : null;

const defaultOf = (field: PolicyField) =>
  isDollars(field) ? ltr(formatUsd(CREDIT_POLICY_DEFAULTS[field])) : CREDIT_POLICY_DEFAULTS[field];

const errorKey = (field: PolicyField) =>
  isDollars(field)
    ? 'dollars'
    : field === 'recipientAlertDays'
      ? 'days'
      : field.endsWith('Hours')
        ? 'hours'
        : 'count';

/** "/settings/credit" (S25 screens): the credit section's limits and cash rules, re-authenticated. */
export function CreditPolicyPage() {
  const { t } = useTranslation();
  const policy = useQuery(creditPolicyQuery);
  return (
    <>
      <PageHeader title={t('creditPolicy.title')} description={t('creditPolicy.subtitle')} />
      {policy.isPending && <Skeleton className="h-96 w-full" aria-hidden="true" />}
      {policy.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, policy.error)}</FormAlert>
          <Button variant="outline" onClick={() => policy.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {policy.isSuccess && <PolicyForm policy={policy.data} />}
    </>
  );
}

function PolicyForm({ policy }: { policy: CreditPolicy }) {
  const { t } = useTranslation();
  const setPolicy = useSetCreditPolicy();
  const [texts, setTexts] = useState(
    () =>
      Object.fromEntries(
        (Object.keys(CREDIT_POLICY_DEFAULTS) as PolicyField[]).map((field) => [
          field,
          textOf(field, policy[field]),
        ]),
      ) as Record<PolicyField, string>,
  );
  const [invalid, setInvalid] = useState<PolicyField[]>([]);
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const values = Object.fromEntries(
      (Object.keys(texts) as PolicyField[]).map((field) => [
        field,
        parsedValue(field, texts[field].trim()),
      ]),
    );
    const parsed = creditPolicySchema.safeParse(values);
    setInvalid([
      ...new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0] as PolicyField)),
    ]);
    if (!parsed.success) return focusInvalid();
    try {
      await setPolicy.mutateAsync(parsed.data);
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <form ref={ref} className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {SECTIONS.map((section) => (
        <Card key={section.title} className="gap-5">
          <div className="flex flex-col gap-1">
            <CardTitle>{t(`creditPolicy.sections.${section.title}`)}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t(`creditPolicy.sections.${section.title}Help`)}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {section.fields.map((field) => (
              <Field key={field} invalid={invalid.includes(field)}>
                <FieldLabel>{t(`creditPolicy.fields.${field}.label`)}</FieldLabel>
                <Input
                  name={field}
                  dir="ltr"
                  inputMode={isDollars(field) ? 'decimal' : 'numeric'}
                  autoComplete="off"
                  value={texts[field]}
                  onChange={(event) => {
                    setTexts((previous) => ({ ...previous, [field]: event.target.value }));
                    setSaved(false);
                  }}
                />
                <FieldDescription>
                  {t(`creditPolicy.fields.${field}.help`)}{' '}
                  {t('creditPolicy.default', { value: defaultOf(field) })}
                </FieldDescription>
                <FieldError match={invalid.includes(field)}>
                  {t(`creditPolicy.errors.${errorKey(field)}`)}
                </FieldError>
              </Field>
            ))}
          </div>
        </Card>
      ))}
      {failure && <FormAlert>{failure}</FormAlert>}
      <InvalidAlert show={invalid.length > 0} />
      {saved && (
        <p role="status" className="text-sm font-medium text-status-success-foreground">
          {t('creditPolicy.saved')}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={setPolicy.isPending}>
        {setPolicy.isPending ? t('creditPolicy.saving') : t('creditPolicy.save')}
      </Button>
    </form>
  );
}
