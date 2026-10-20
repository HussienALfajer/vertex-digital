import { createFileRoute } from '@tanstack/react-router';
import { MerchantsPage } from '../../features/merchants/merchants-page';
import { parseMerchantsSearch } from '../../features/merchants/merchants-search';

export const Route = createFileRoute('/_app/merchants/')({
  validateSearch: parseMerchantsSearch,
  component: MerchantsRoute,
});

function MerchantsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <MerchantsPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
