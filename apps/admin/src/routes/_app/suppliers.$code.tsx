import { createFileRoute, notFound } from '@tanstack/react-router';
import { SupplierPage } from '../../features/suppliers/supplier-page';
import { parseSupplierSearch, supplierCodeOf } from '../../features/suppliers/supplier-search';

/** `:code` names a supplier; `?tab=` and the offers' filters are in the URL. */
export const Route = createFileRoute('/_app/suppliers/$code')({
  validateSearch: parseSupplierSearch,
  beforeLoad: ({ params }) => {
    if (!supplierCodeOf(params.code)) throw notFound();
  },
  component: SupplierRoute,
});

function SupplierRoute() {
  const { code } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const supplier = supplierCodeOf(code);
  if (!supplier) return null;
  return (
    // A new key resets the page's forms and selection when another supplier opens.
    <SupplierPage
      key={supplier}
      code={supplier}
      search={search}
      onSearch={(next) => navigate({ search: () => next, replace: true })}
    />
  );
}
