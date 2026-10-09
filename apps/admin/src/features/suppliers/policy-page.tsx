import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  SUPPLIER_POLICY_DEFAULTS,
  type SupplierPolicy,
  supplierPolicySchema,
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
} from '@vertex-digital/ui';
import { ArrowRightIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatPercentBp, parsePercentBp } from '../pricing/pricing-format';
import { policyQuery, useSetPolicy } from './suppliers.queries';

type PolicyField = keyof SupplierPolicy;

/** Fields typed as a percent and stored in basis points; the others are whole numbers. */
const PERCENT_FIELDS: readonly PolicyField[] = [
  'priceReviewThresholdBp',
  'degradedSuccessBp',
  'downSuccessBp',
];

/** The form's sections, in order (ADR 0021). */
const SECTIONS: { title: 'prices' | 'health'; fields: PolicyField[] }[] = [
  { title: 'prices', fields: ['priceReviewThresholdBp', 'costStaleMinutes'] },
  {
    title: 'health',
    fields: [
      'healthWindowMinutes',
      'healthMinCalls',
      'degradedSuccessBp',
      'degradedP90Ms',
      'downSuccessBp',
      'downConsecutiveErrors',
      'probeAfterMinutes',
    ],
  },
];

const WHOLE = /^\d{1,6}$/;

const textOf = (field: PolicyField, value: number) =>
  PERCENT_FIELDS.includes(field) ? formatPercentBp(value) : String(value);

const parseField = (field: PolicyField, text: string): number | null => {
  if (PERCENT_FIELDS.includes(field)) return parsePercentBp(text);
  const trimmed = text.trim();
  return WHOLE.test(trimmed) ? Number(trimmed) : null;
};

/** "/suppliers/policy" (S07 screens): the policy's fields with their defaults, re-authenticated. */
export function PolicyPage() {
  const { t } = useTranslation();
  const policy = useQuery(policyQuery);
  return (
    <>
      <PageHeader
        title={t('suppliers.policy.title')}
        description={t('suppliers.policy.subtitle')}
        actions={
          <Button variant="ghost" render={<Link to="/suppliers" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" />
            {t('suppliers.back')}
          </Button>
        }
      />
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

function PolicyForm({ policy }: { policy: SupplierPolicy }) {
  const { t } = useTranslation();
  const setPolicy = useSetPolicy();
  const [texts, setTexts] = useState(
    () =>
      Object.fromEntries(
        (Object.keys(SUPPLIER_POLICY_DEFAULTS) as PolicyField[]).map((field) => [
          field,
          textOf(field, policy[field]),
        ]),
      ) as Record<PolicyField, string>,
  );
  const [invalid, setInvalid] = useState<PolicyField[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const values = Object.fromEntries(
      (Object.keys(texts) as PolicyField[]).map((field) => [
        field,
        parseField(field, texts[field]),
      ]),
    );
    const parsed = supplierPolicySchema.safeParse(values);
    const found = [
      ...new Set(
        (parsed.error?.issues ?? []).map((issue) => issue.path[0] as PolicyField).filter(Boolean),
      ),
    ];
    setInvalid(found);
    if (!parsed.success) return;
    try {
      await setPolicy.mutateAsync(parsed.data);
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {SECTIONS.map((section) => (
        <Card key={section.title} className="gap-5">
          <div className="flex flex-col gap-1">
            <CardTitle>{t(`suppliers.policy.sections.${section.title}`)}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t(`suppliers.policy.sections.${section.title}Help`)}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {section.fields.map((field) => (
              <Field key={field} invalid={invalid.includes(field)}>
                <FieldLabel>{t(`suppliers.policy.fields.${field}.label`)}</FieldLabel>
                <Input
                  name={field}
                  dir="ltr"
                  inputMode="decimal"
                  autoComplete="off"
                  value={texts[field]}
                  onChange={(event) => {
                    setTexts((previous) => ({ ...previous, [field]: event.target.value }));
                    setSaved(false);
                  }}
                />
                <FieldDescription>
                  {t(`suppliers.policy.fields.${field}.hint`)}{' '}
                  {t('suppliers.policy.default', {
                    value: textOf(field, SUPPLIER_POLICY_DEFAULTS[field]),
                  })}
                </FieldDescription>
                <FieldError match={invalid.includes(field)}>
                  {t(`suppliers.policy.fields.${field}.error`)}
                </FieldError>
              </Field>
            ))}
          </div>
        </Card>
      ))}
      {failure && <FormAlert>{failure}</FormAlert>}
      {saved && (
        <p role="status" className="text-sm font-medium text-status-success-foreground">
          {t('suppliers.policy.saved')}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={setPolicy.isPending}>
        {setPolicy.isPending ? t('suppliers.policy.saving') : t('suppliers.policy.save')}
      </Button>
    </form>
  );
}
