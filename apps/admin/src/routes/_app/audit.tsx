import { createFileRoute } from '@tanstack/react-router';
import { AuditPage } from '../../features/audit/audit-page';
import { parseAuditSearch } from '../../features/audit/audit-search';

export const Route = createFileRoute('/_app/audit')({
  validateSearch: parseAuditSearch,
  component: AuditRoute,
});

function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // The filters replace the whole search: nothing from another page's URL carries over.
  return <AuditPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
