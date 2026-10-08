import { createFileRoute } from '@tanstack/react-router';
import { parseTransferSearch } from '../../features/deposits/transfer-search';
import { TransfersPage } from '../../features/deposits/transfers-page';

export const Route = createFileRoute('/_app/deposits/transfers')({
  validateSearch: parseTransferSearch,
  component: TransfersRoute,
});

function TransfersRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <TransfersPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
