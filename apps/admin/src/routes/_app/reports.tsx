import { createFileRoute } from '@tanstack/react-router';
import { parseReportSearch } from '../../features/reports/report-search';
import { ReportsPage } from '../../features/reports/reports-page';

export const Route = createFileRoute('/_app/reports')({
  validateSearch: parseReportSearch,
  component: ReportsRoute,
});

function ReportsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <ReportsPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
