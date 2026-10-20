import { createFileRoute } from '@tanstack/react-router';
import { PriceListPage } from '../../features/pricing/price-list-page';

export const Route = createFileRoute('/_app/pricing/lists/$id')({
  component: PriceListRoute,
});

function PriceListRoute() {
  const { id } = Route.useParams();
  return <PriceListPage key={id} id={id} />;
}
