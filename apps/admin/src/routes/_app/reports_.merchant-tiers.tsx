import { createFileRoute } from '@tanstack/react-router';
import { MerchantTierReportPage } from '../../features/reports/merchant-tier-report';
import { parseTierReportSearch } from '../../features/reports/report-search';

export const Route = createFileRoute('/_app/reports_/merchant-tiers')({
  validateSearch: parseTierReportSearch,
  component: MerchantTierReportRoute,
});

function MerchantTierReportRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MerchantTierReportPage search={search} onSearch={(next) => navigate({ search: () => next })} />
  );
}
