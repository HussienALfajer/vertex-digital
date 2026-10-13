import { createFileRoute } from '@tanstack/react-router';
import { NewOrderPage } from '../../features/orders/new-order-page';
import { parseNewOrderSearch } from '../../features/orders/new-order-search';

export const Route = createFileRoute('/_app/orders/new')({
  validateSearch: parseNewOrderSearch,
  component: NewOrderRoute,
});

function NewOrderRoute() {
  const search = Route.useSearch();
  return <NewOrderPage preset={search} />;
}
