import { createFileRoute } from '@tanstack/react-router';
import { RateSourcePage } from '../../features/rates/rate-source-page';

export const Route = createFileRoute('/_app/rates/sources/$id')({
  component: SourceRoute,
});

function SourceRoute() {
  const { id } = Route.useParams();
  // A new key resets the form when another source opens.
  return <RateSourcePage key={id} id={id} />;
}
