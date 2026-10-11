import { createFileRoute } from '@tanstack/react-router';
import { parseArchivedSearch } from '../../features/content/content-search';
import { FaqPage } from '../../features/content/faq-page';

export const Route = createFileRoute('/_app/content/faq')({
  validateSearch: parseArchivedSearch,
  component: FaqPageRoute,
});

function FaqPageRoute() {
  const { archived } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <FaqPage
      archived={!!archived}
      onArchived={(next) => navigate({ search: next ? { archived: true } : {}, replace: true })}
    />
  );
}
