import { createFileRoute } from '@tanstack/react-router';
import { ReconciliationPage } from '../../features/reconciliation/reconciliation-page';
import { parseReconciliationSearch } from '../../features/reconciliation/reconciliation-search';

export const Route = createFileRoute('/_app/reconciliation/')({
  validateSearch: parseReconciliationSearch,
  component: ReconciliationRoute,
});

function ReconciliationRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReconciliationPage search={search} onSearch={(next) => navigate({ search: () => next })} />
  );
}
