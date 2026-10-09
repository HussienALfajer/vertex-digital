import { createFileRoute } from '@tanstack/react-router';
import { parseOrderSearch } from '../../features/orders/order-search';
import { OrdersPage } from '../../features/orders/orders-page';

export const Route = createFileRoute('/_app/orders/')({
  validateSearch: parseOrderSearch,
  component: OrdersRoute,
});

function OrdersRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <OrdersPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
