import { createFileRoute } from '@tanstack/react-router';
import { parseDepositSearch } from '../../features/deposits/deposit-search';
import { DepositsPage } from '../../features/deposits/deposits-page';

export const Route = createFileRoute('/_app/deposits/')({
  validateSearch: parseDepositSearch,
  component: DepositsRoute,
});

function DepositsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <DepositsPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
