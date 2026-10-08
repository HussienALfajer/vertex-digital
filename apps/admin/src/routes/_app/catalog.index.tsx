import { createFileRoute } from '@tanstack/react-router';
import { CatalogPage } from '../../features/catalog/catalog-page';
import { parseCatalogSearch } from '../../features/catalog/catalog-search';

export const Route = createFileRoute('/_app/catalog/')({
  validateSearch: parseCatalogSearch,
  component: CatalogRoute,
});

function CatalogRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CatalogPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
