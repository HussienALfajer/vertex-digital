import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ORDER_POLICY_DEFAULTS,
  type OrderPolicy,
  orderPolicySchema,
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
import { orderPolicyQuery, useSetOrderPolicy } from './orders.queries';

type PolicyField = keyof OrderPolicy;

/** The form's sections, in order (rules F7, MN2), each field in its own unit. */
const SECTIONS: { title: 'polling' | 'review' | 'manual'; fields: PolicyField[] }[] = [
  {
    title: 'polling',
    fields: ['firstPollSeconds', 'fastPollSeconds', 'fastPollMinutes', 'slowPollSeconds'],
  },
  { title: 'review', fields: ['hardLimitMinutes', 'reviewPollMinutes', 'reviewPollHours'] },
  { title: 'manual', fields: ['manualReminderMinutes'] },
];

const WHOLE = /^\d{1,5}$/;

/** "/orders/policy" (S08 screens): the policy's fields with their defaults, re-authenticated. */
export function OrderPolicyPage() {
  const { t } = useTranslation();
  const policy = useQuery(orderPolicyQuery);
  return (
    <>
      <PageHeader
        title={t('orders.policy.title')}
        description={t('orders.policy.subtitle')}
        actions={
          <Button variant="ghost" render={<Link to="/orders" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" />
            {t('orders.back')}
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

function PolicyForm({ policy }: { policy: OrderPolicy }) {
  const { t } = useTranslation();
  const setPolicy = useSetOrderPolicy();
  const [texts, setTexts] = useState(
    () =>
      Object.fromEntries(
        (Object.keys(ORDER_POLICY_DEFAULTS) as PolicyField[]).map((field) => [
          field,
          String(policy[field]),
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
      (Object.keys(texts) as PolicyField[]).map((field) => {
        const text = texts[field].trim();
        return [field, WHOLE.test(text) ? Number(text) : null];
      }),
    );
    const parsed = orderPolicySchema.safeParse(values);
    setInvalid([
      ...new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0] as PolicyField)),
    ]);
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
            <CardTitle>{t(`orders.policy.sections.${section.title}`)}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t(`orders.policy.sections.${section.title}Help`)}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {section.fields.map((field) => (
              <Field key={field} invalid={invalid.includes(field)}>
                <FieldLabel>{t(`orders.policy.fields.${field}.label`)}</FieldLabel>
                <Input
                  name={field}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="off"
                  value={texts[field]}
                  onChange={(event) => {
                    setTexts((previous) => ({ ...previous, [field]: event.target.value }));
                    setSaved(false);
                  }}
                />
                <FieldDescription>
                  {t('orders.policy.default', { value: ORDER_POLICY_DEFAULTS[field] })}
                </FieldDescription>
                <FieldError match={invalid.includes(field)}>
                  {t(`orders.policy.fields.${field}.error`)}
                </FieldError>
              </Field>
            ))}
          </div>
        </Card>
      ))}
      {failure && <FormAlert>{failure}</FormAlert>}
      {saved && (
        <p role="status" className="text-sm font-medium text-status-success-foreground">
          {t('orders.policy.saved')}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={setPolicy.isPending}>
        {setPolicy.isPending ? t('orders.policy.saving') : t('orders.policy.save')}
      </Button>
    </form>
  );
}
