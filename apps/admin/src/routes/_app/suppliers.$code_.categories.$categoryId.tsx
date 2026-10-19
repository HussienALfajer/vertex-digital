import { createFileRoute, notFound } from '@tanstack/react-router';
import { CategoryPage } from '../../features/suppliers/category-page';
import {
  categoryIdOf,
  parseOfferSearch,
  supplierCodeOf,
} from '../../features/suppliers/supplier-search';

/** S18: one supplier category and its offers; the offers' filters and page are in the URL. */
export const Route = createFileRoute('/_app/suppliers/$code_/categories/$categoryId')({
  validateSearch: parseOfferSearch,
  beforeLoad: ({ params }) => {
    if (!supplierCodeOf(params.code) || !categoryIdOf(params.categoryId)) throw notFound();
  },
  component: CategoryRoute,
});

function CategoryRoute() {
  const { code, categoryId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const supplier = supplierCodeOf(code);
  if (!supplier) return null;
  return (
    // A new key resets the selection when another category opens.
    <CategoryPage
      key={`${supplier}:${categoryId}`}
      code={supplier}
      categoryId={categoryId}
      search={search}
      onSearch={(next) => navigate({ search: () => next, replace: true })}
    />
  );
}
