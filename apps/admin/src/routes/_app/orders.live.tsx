import { createFileRoute } from '@tanstack/react-router';
import { LivePage } from '../../features/orders/live-page';
import { parseLiveSearch } from '../../features/orders/live-search';

export const Route = createFileRoute('/_app/orders/live')({
  validateSearch: parseLiveSearch,
  component: LiveRoute,
});

function LiveRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <LivePage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
