import type { AdminOrder } from '@vertex-digital/contracts';
import { Button, Dialog } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { DecisionDialog, type OrderDecision } from './decision-dialogs';
import { FulfilDialog } from './fulfil-dialog';
import { RerouteDialog } from './reroute-dialog';

/** S08's four decisions and S11's reroute and manual fulfil, each its own dialog. */
export type OrderAction = OrderDecision | 'reroute' | 'fulfil';

/** Whether the order allows any action now (rule D1; S11 rules RR1, MF1, RF1). */
export const hasActions = ({ decisions }: AdminOrder) =>
  decisions.poll || decisions.resolve || decisions.refund || decisions.reroute || decisions.fulfil;

/** The buttons of the actions the order allows now, in the order the admin weighs them. */
export function OrderActionButtons({
  order,
  onAction,
}: {
  order: AdminOrder;
  onAction: (action: OrderAction) => void;
}) {
  const { t } = useTranslation();
  const { decisions } = order;
  return (
    <div className="flex flex-wrap gap-2">
      {decisions.poll && (
        <Button variant="outline" onClick={() => onAction('poll')}>
          {t('orders.decisions.poll.open')}
        </Button>
      )}
      {/* S11 rule MF1: a manual attempt is delivered by the manual fulfil, with its proof. */}
      {decisions.resolveDelivered && (
        <Button variant="outline" onClick={() => onAction('delivered')}>
          {t('orders.decisions.delivered.open')}
        </Button>
      )}
      {decisions.resolve && (
        <Button variant="outline" onClick={() => onAction('failed')}>
          {t('orders.decisions.failed.open')}
        </Button>
      )}
      {decisions.reroute && (
        <Button variant="outline" onClick={() => onAction('reroute')}>
          {t('orders.reroute.open')}
        </Button>
      )}
      {decisions.fulfil && (
        <Button onClick={() => onAction('fulfil')}>{t('orders.fulfil.open')}</Button>
      )}
      {decisions.refund && (
        <Button variant="destructive" onClick={() => onAction('refund')}>
          {t('orders.decisions.refund.open')}
        </Button>
      )}
    </div>
  );
}

/** The open action's dialog; `onClose` runs when it is dismissed or done. */
export function OrderActionDialog({
  order,
  action,
  onClose,
}: {
  order: AdminOrder;
  action: OrderAction | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onClose()}>
      {action === 'reroute' && <RerouteDialog order={order} onDone={onClose} />}
      {action === 'fulfil' && <FulfilDialog order={order} onDone={onClose} />}
      {action !== null && action !== 'reroute' && action !== 'fulfil' && (
        <DecisionDialog order={order} decision={action} onDone={onClose} />
      )}
    </Dialog>
  );
}
