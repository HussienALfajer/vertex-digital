import { createFileRoute } from '@tanstack/react-router';
import { BannersPage } from '../../features/content/banners-page';
import { parseArchivedSearch } from '../../features/content/content-search';

export const Route = createFileRoute('/_app/content/banners')({
  validateSearch: parseArchivedSearch,
  component: BannersPageRoute,
});

function BannersPageRoute() {
  const { archived } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BannersPage
      archived={!!archived}
      onArchived={(next) => navigate({ search: next ? { archived: true } : {}, replace: true })}
    />
  );
}
