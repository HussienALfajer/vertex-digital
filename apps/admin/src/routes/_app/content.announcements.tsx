import { createFileRoute } from '@tanstack/react-router';
import { AnnouncementsPage } from '../../features/content/announcements-page';
import { parseArchivedSearch } from '../../features/content/content-search';

export const Route = createFileRoute('/_app/content/announcements')({
  validateSearch: parseArchivedSearch,
  component: AnnouncementsPageRoute,
});

function AnnouncementsPageRoute() {
  const { archived } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AnnouncementsPage
      archived={!!archived}
      onArchived={(next) => navigate({ search: next ? { archived: true } : {}, replace: true })}
    />
  );
}
