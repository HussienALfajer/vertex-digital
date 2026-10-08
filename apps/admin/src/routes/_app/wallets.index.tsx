import { createFileRoute } from '@tanstack/react-router';
import { WalletsPage } from '../../features/wallet/wallets-page';

/** `?q=`: the wallet search, kept when it is long enough for the API (3–100 characters). */
function parseWalletsSearch(search: Record<string, unknown>): { q?: string } {
  const q = typeof search.q === 'string' ? search.q.trim() : '';
  return q.length >= 3 && q.length <= 100 ? { q } : {};
}

export const Route = createFileRoute('/_app/wallets/')({
  validateSearch: parseWalletsSearch,
  component: WalletsRoute,
});

function WalletsRoute() {
  const { q } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <WalletsPage q={q} onSearch={(next) => navigate({ search: next ? { q: next } : {} })} />;
}
