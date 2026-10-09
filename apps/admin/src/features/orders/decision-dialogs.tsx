import {
  type AdminOrder,
  pollAttemptSchema,
  refundOrderSchema,
  resolveAttemptSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Callout,
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
  Textarea,
} from '@vertex-digital/ui';
import { TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useIdempotencyKey } from '../../lib/idempotency';
import { usePollAttempt, useRefundOrder, useResolveAttempt } from './orders.queries';

/** The four decisions of rule D1, each its own dialog. */
export type OrderDecision = 'poll' | 'delivered' | 'failed' | 'refund';

type Errors = Partial<Record<'reason' | 'quantity' | 'codes', boolean>>;

/**
 * One decision on a held order or an open manual attempt (rules D1–D5): a reason of 5 to 500
 * characters, re-authentication, and for the three that move money or goods the dialog's
 * `Idempotency-Key`, kept across re-authentication and retries. Values stay on an error.
 */
export function DecisionDialog({
  order,
  decision,
  onDone,
}: {
  order: AdminOrder;
  decision: OrderDecision;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const attemptId = order.decisions.attemptId as string;
  const attempt = order.attempts.find((item) => item.id === attemptId);
  const units = attempt?.quantity ?? 1;
  const codeProduct = order.product.kind === 'code';
  const poll = usePollAttempt(order.id);
  const resolve = useResolveAttempt(order.id);
  const refund = useRefundOrder(order.id);
  const keyFor = useIdempotencyKey();
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const pending = poll.isPending || resolve.isPending || refund.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') ?? '');
    try {
      if (decision === 'poll') {
        const parsed = pollAttemptSchema.safeParse({ reason });
        setErrors({ reason: !parsed.success });
        if (!parsed.success) return;
        await poll.mutateAsync({ attemptId, body: parsed.data });
      } else if (decision === 'refund') {
        const parsed = refundOrderSchema.safeParse({ reason });
        setErrors({ reason: !parsed.success });
        if (!parsed.success) return;
        await refund.mutateAsync({ body: parsed.data, key: keyFor(parsed.data) });
      } else {
        const quantity = Number(String(form.get('quantity') ?? units).trim());
        const codes = String(form.get('codes') ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const body =
          decision === 'failed'
            ? { outcome: 'failed' as const, reason }
            : { outcome: 'delivered' as const, quantity, codes, reason };
        const parsed = resolveAttemptSchema.safeParse(body);
        const paths = new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0]));
        const codesWrong = decision === 'delivered' && codeProduct && codes.length !== quantity;
        const quantityWrong =
          decision === 'delivered' &&
          (paths.has('quantity') || !Number.isInteger(quantity) || quantity > units);
        setErrors({
          reason: paths.has('reason'),
          quantity: quantityWrong,
          codes: paths.has('codes') || codesWrong,
        });
        if (!parsed.success || quantityWrong || codesWrong) return;
        await resolve.mutateAsync({ attemptId, body, key: keyFor(body) });
      }
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t(`orders.decisions.${decision}.title`)}</DialogTitle>
        <DialogDescription>
          {t(`orders.decisions.${decision}.description`, { number: order.number })}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {decision === 'delivered' && (
          <>
            <Field invalid={!!errors.quantity}>
              <FieldLabel>{t('orders.decisions.delivered.quantity')}</FieldLabel>
              <Input
                name="quantity"
                dir="ltr"
                inputMode="numeric"
                autoComplete="off"
                defaultValue={String(units)}
              />
              <FieldDescription>
                {t('orders.decisions.delivered.quantityHint', { units })}
              </FieldDescription>
              <FieldError match={!!errors.quantity}>
                {t('orders.decisions.delivered.quantityError', { units })}
              </FieldError>
            </Field>
            {codeProduct && (
              <Field invalid={!!errors.codes}>
                <FieldLabel>{t('orders.decisions.delivered.codes')}</FieldLabel>
                <Textarea name="codes" dir="ltr" rows={5} spellCheck={false} autoComplete="off" />
                <FieldDescription>{t('orders.decisions.delivered.codesHint')}</FieldDescription>
                <FieldError match={!!errors.codes}>
                  {t('orders.decisions.delivered.codesError')}
                </FieldError>
              </Field>
            )}
          </>
        )}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('orders.decisions.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldError match={!!errors.reason}>{t('orders.decisions.reasonError')}</FieldError>
        </Field>
        {decision === 'refund' && (
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={t('orders.decisions.refund.warning')}
          />
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button
            type="submit"
            variant={decision === 'refund' || decision === 'failed' ? 'destructive' : 'primary'}
            disabled={pending}
          >
            {pending ? t('orders.decisions.submitting') : t(`orders.decisions.${decision}.submit`)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
