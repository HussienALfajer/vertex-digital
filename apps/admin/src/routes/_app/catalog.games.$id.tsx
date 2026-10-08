import { createFileRoute } from '@tanstack/react-router';
import { GAME_TABS, GamePage, type GameTab } from '../../features/catalog/game-page';

/** `?tab=`: the open tab; absent for the data tab. */
export const Route = createFileRoute('/_app/catalog/games/$id')({
  validateSearch: (search): { tab?: Exclude<GameTab, 'data'> } =>
    (GAME_TABS as readonly unknown[]).includes(search.tab) && search.tab !== 'data'
      ? { tab: search.tab as Exclude<GameTab, 'data'> }
      : {},
  component: GameRoute,
});

function GameRoute() {
  const { id } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    // A new key resets the page's forms and dialogs when another game opens.
    <GamePage
      key={id}
      id={id}
      tab={tab ?? 'data'}
      onTab={(next) => navigate({ search: next === 'data' ? {} : { tab: next }, replace: true })}
    />
  );
}
