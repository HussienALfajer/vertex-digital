import { createFileRoute } from '@tanstack/react-router';
import { SupportPage } from '../../features/support/support-page';
import { parseSupportSearch } from '../../features/support/support-search';

export const Route = createFileRoute('/_app/support/')({
  validateSearch: parseSupportSearch,
  component: SupportRoute,
});

function SupportRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <SupportPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
