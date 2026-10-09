import { createFileRoute } from '@tanstack/react-router';
import { OrderPage } from '../../features/orders/order-page';

export const Route = createFileRoute('/_app/orders/$id')({
  component: OrderRoute,
});

function OrderRoute() {
  const { id } = Route.useParams();
  // A new key resets the page's dialogs and revealed codes when another order opens.
  return <OrderPage key={id} id={id} />;
}
