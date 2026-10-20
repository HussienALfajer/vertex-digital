import { createFileRoute } from '@tanstack/react-router';
import { MatrixPage } from '../../features/pricing/matrix-page';
import { parseMatrixSearch } from '../../features/pricing/matrix-search';

export const Route = createFileRoute('/_app/pricing/matrix')({
  validateSearch: parseMatrixSearch,
  component: MatrixRoute,
});

function MatrixRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <MatrixPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
