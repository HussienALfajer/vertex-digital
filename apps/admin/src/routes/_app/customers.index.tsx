import { createFileRoute } from '@tanstack/react-router';
import { parseCustomerSearch } from '../../features/customers/customer-search';
import { CustomersPage } from '../../features/customers/customers-page';

export const Route = createFileRoute('/_app/customers/')({
  validateSearch: parseCustomerSearch,
  component: CustomersRoute,
});

function CustomersRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CustomersPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
