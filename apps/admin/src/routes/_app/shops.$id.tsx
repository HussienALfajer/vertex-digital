import { createFileRoute } from '@tanstack/react-router';
import { ShopPage } from '../../features/shops/shop-page';
import { parseShopTab } from '../../features/shops/shops-search';

/** `?tab=`: the open tab; absent for the overview. */
export const Route = createFileRoute('/_app/shops/$id')({
  validateSearch: parseShopTab,
  component: ShopRoute,
});

function ShopRoute() {
  const { id } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    // A new key resets the page's dialogs when another shop opens.
    <ShopPage
      key={id}
      id={id}
      tab={tab ?? 'overview'}
      onTab={(next) =>
        navigate({ search: next === 'overview' ? {} : { tab: next }, replace: true })
      }
    />
  );
}
