import { createFileRoute } from '@tanstack/react-router';
import { QuickLinksPage } from '../../features/catalog/quick-links-page';
import { parseQuickLinksSearch } from '../../features/catalog/quick-links-search';

export const Route = createFileRoute('/_app/catalog/quick-links')({
  validateSearch: parseQuickLinksSearch,
  component: QuickLinksRoute,
});

function QuickLinksRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <QuickLinksPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
