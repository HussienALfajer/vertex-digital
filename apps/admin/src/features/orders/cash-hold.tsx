import { type AdminOrder, cashApprovalInputSchema, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  type BadgeProps,
  Button,
  Callout,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { useCashApproval } from './orders.queries';

type CashDecision = 'approve' | 'reject';

type CashHold = NonNullable<AdminOrder['cashHold']>;

export const CASH_HOLD_TONES: Record<CashHold['state'], BadgeProps['tone']> = {
  held: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
};

/**
 * S25 CS3–CS5: a cash order's approval hold. While held, "موافقة" sends it to fulfilment and
 * "رفض" refunds the whole order (each its own re-authenticated dialog); afterwards, who decided
 * and when. Above the Telegram ceiling the panel is the only place to decide (CS4).
 */
export function CashHoldCard({ order, hold }: { order: AdminOrder; hold: CashHold }) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<CashDecision | null>(null);
  const held = hold.state === 'held';
  return (
    <Card className={held ? 'gap-4 border-status-warning' : 'gap-4'}>
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle>{t('orders.cashHold.title')}</CardTitle>
        <Badge tone={CASH_HOLD_TONES[hold.state]}>
          {t(`orders.cashHold.states.${hold.state}`)}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {held
          ? t('orders.cashHold.heldHelp', { time: formatDateTime(hold.expiresAt) })
          : hold.decidedAt
            ? t(hold.adminName ? 'orders.cashHold.decidedBy' : 'orders.cashHold.decidedAt', {
                time: formatDateTime(hold.decidedAt),
                name: hold.adminName ?? '',
              })
            : null}
      </p>
      {held && !hold.telegramDecides && (
        <p className="text-sm font-medium">{t('orders.cashHold.panelOnly')}</p>
      )}
      {held && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDecision('approve')}>
            {t('orders.cashHold.approve.open')}
          </Button>
          <Button variant="destructive" onClick={() => setDecision('reject')}>
            {t('orders.cashHold.reject.open')}
          </Button>
        </div>
      )}
      <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
        {decision && (
          <CashDecisionDialog order={order} decision={decision} onDone={() => setDecision(null)} />
        )}
      </Dialog>
    </Card>
  );
}

function CashDecisionDialog({
  order,
  decision,
  onDone,
}: {
  order: AdminOrder;
  decision: CashDecision;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const decide = useCashApproval(order.id);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const amount = ltr(formatUsd(order.totalUsdUnits));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    const parsed = cashApprovalInputSchema.safeParse({
      decision,
      ...(reason === '' ? {} : { reason }),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    try {
      await decide.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t(`orders.cashHold.${decision}.title`)}</DialogTitle>
        <DialogDescription>
          {t(`orders.cashHold.${decision}.description`, { number: order.number, amount })}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('orders.cashHold.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldDescription>{t('orders.cashHold.reasonHint')}</FieldDescription>
          <FieldError match={invalid}>{t('orders.cashHold.reasonError')}</FieldError>
        </Field>
        {decision === 'reject' && (
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={t('orders.cashHold.reject.warning', { amount })}
          />
        )}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button
            type="submit"
            variant={decision === 'reject' ? 'destructive' : 'primary'}
            disabled={decide.isPending}
          >
            {decide.isPending
              ? t('orders.decisions.submitting')
              : t(`orders.cashHold.${decision}.submit`, { amount })}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
