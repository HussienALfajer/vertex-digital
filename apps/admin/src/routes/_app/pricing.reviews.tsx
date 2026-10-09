import { createFileRoute } from '@tanstack/react-router';
import { parseReviewSearch } from '../../features/pricing/review-search';
import { ReviewsPage } from '../../features/pricing/reviews-page';

export const Route = createFileRoute('/_app/pricing/reviews')({
  validateSearch: parseReviewSearch,
  component: ReviewsRoute,
});

function ReviewsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <ReviewsPage search={search} onSearch={(next) => navigate({ search: () => next })} />;
}
