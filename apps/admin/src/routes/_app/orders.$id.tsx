import { createFileRoute } from '@tanstack/react-router';
import { OrderPage } from '../../features/orders/order-page';

export const Route = createFileRoute('/_app/orders/$id')({
  // S11 edge case 10: the Telegram manual order card opens the manual fulfil.
  validateSearch: (search: Record<string, unknown>): { decide?: 'fulfil' } =>
    search.decide === 'fulfil' ? { decide: 'fulfil' } : {},
  component: OrderRoute,
});

function OrderRoute() {
  const { id } = Route.useParams();
  const { decide } = Route.useSearch();
  // A new key resets the page's dialogs and revealed codes when another order opens.
  return <OrderPage key={id} id={id} decide={decide} />;
}
