import { createFileRoute } from '@tanstack/react-router';
import { ShopsPage } from '../../features/shops/shops-page';
import { parseShopsSearch } from '../../features/shops/shops-search';

export const Route = createFileRoute('/_app/shops/')({
  validateSearch: parseShopsSearch,
  component: ShopsRoute,
});

function ShopsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <ShopsPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
