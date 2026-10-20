import { createFileRoute } from '@tanstack/react-router';
import { ApplicationsPage } from '../../features/merchants/applications-page';
import { parseApplicationsSearch } from '../../features/merchants/merchants-search';

export const Route = createFileRoute('/_app/merchants/applications/')({
  validateSearch: parseApplicationsSearch,
  component: ApplicationsRoute,
});

function ApplicationsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <ApplicationsPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
