import { createFileRoute } from '@tanstack/react-router';
import { parseCatalogSearch } from '../../features/catalog/catalog-search';
import { NewGamePage } from '../../features/catalog/game-page';

/** `?category=`: the category the new game starts in, from the catalog tab it was added from. */
export const Route = createFileRoute('/_app/catalog/games/new')({
  validateSearch: (search): { category?: string } => {
    const { category } = parseCatalogSearch(search);
    return category ? { category } : {};
  },
  component: NewGameRoute,
});

function NewGameRoute() {
  const { category } = Route.useSearch();
  return <NewGamePage categoryId={category} />;
}
