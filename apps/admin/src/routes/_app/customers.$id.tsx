import { createFileRoute } from '@tanstack/react-router';
import { CustomerPage } from '../../features/customers/customer-page';
import { parseCustomerTab } from '../../features/customers/customer-search';

/** `?tab=`: the open tab; absent for the summary. */
export const Route = createFileRoute('/_app/customers/$id')({
  validateSearch: parseCustomerTab,
  component: CustomerRoute,
});

function CustomerRoute() {
  const { id } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    // A new key resets the page's dialogs when another customer opens.
    <CustomerPage
      key={id}
      id={id}
      tab={tab ?? 'summary'}
      onTab={(next) => navigate({ search: next === 'summary' ? {} : { tab: next }, replace: true })}
    />
  );
}
