import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type FulfilmentAttempt,
  formatUsd,
  NEARBY_SUPPLIER_ORDER_MINUTES,
  supplierPanelCapabilities,
} from '@vertex-digital/contracts';
import { Badge, Button, Callout } from '@vertex-digital/ui';
import { SearchIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { nearbySupplierOrdersQuery } from './orders.queries';

/** An attempt still open or held: its outcome may be one of the supplier's orders (RS3). */
const OPEN = new Set<FulfilmentAttempt['status']>(['sending', 'pending', 'unknown']);

/** Whether the order page offers the nearby orders for this attempt (SF4). */
export const showsNearbyOrders = (attempt: FulfilmentAttempt) =>
  attempt.kind === 'routed' &&
  OPEN.has(attempt.status) &&
  supplierPanelCapabilities(attempt.supplierCode).statement;

/**
 * "طلبات المورد القريبة" (S16 SF4, RS3): the supplier's orders for the same offer and quantity
 * within 15 minutes of the send, read live on request, each marked when another attempt already
 * holds it. An incomplete read says so: an empty list is then no proof the supplier has none, so
 * the admin does not confirm "failed" on it.
 */
export function NearbySupplierOrders({
  orderId,
  attempt,
}: {
  orderId: string;
  attempt: FulfilmentAttempt;
}) {
  const { t } = useTranslation();
  const [asked, setAsked] = useState(false);
  const nearby = useQuery({ ...nearbySupplierOrdersQuery(orderId, attempt.id), enabled: asked });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-bold">{t('orders.nearby.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('orders.nearby.hint', { minutes: NEARBY_SUPPLIER_ORDER_MINUTES })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={nearby.isFetching}
          onClick={() => (asked ? nearby.refetch() : setAsked(true))}
        >
          <SearchIcon />
          {nearby.isFetching
            ? t('orders.nearby.reading')
            : asked
              ? t('orders.nearby.again')
              : t('orders.nearby.read')}
        </Button>
      </div>
      {nearby.isError && <FormAlert>{errorMessage(t, nearby.error)}</FormAlert>}
      {nearby.isSuccess && (
        <>
          {!nearby.data.complete && (
            <Callout
              tone="warning"
              icon={<TriangleAlertIcon />}
              title={t('orders.nearby.incomplete')}
              description={t('orders.nearby.incompleteHint')}
            />
          )}
          {nearby.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('orders.nearby.none')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border text-sm">
              {nearby.data.items.map((order) => {
                const mine = order.match?.attemptId === attempt.id;
                return (
                  <li
                    key={order.supplierOrderId}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="flex flex-col gap-0.5">
                      <bdi dir="ltr" className="font-medium">
                        {order.supplierOrderId}
                      </bdi>
                      <span className="text-xs text-muted-foreground">
                        {[
                          order.createdAt ? formatDateTime(order.createdAt) : null,
                          order.quantity !== null
                            ? t('orders.nearby.quantity', { quantity: order.quantity })
                            : null,
                          order.totalUsdUnits !== null ? formatUsd(order.totalUsdUnits) : null,
                          order.status,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {order.match === null ? (
                      <Badge tone="gold">{t('orders.nearby.free')}</Badge>
                    ) : mine ? (
                      <Badge tone="success">{t('orders.nearby.thisAttempt')}</Badge>
                    ) : (
                      <Link
                        to="/orders/$id"
                        params={{ id: order.match.orderId }}
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {t('orders.nearby.otherAttempt', { order: order.match.orderNumber })}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
