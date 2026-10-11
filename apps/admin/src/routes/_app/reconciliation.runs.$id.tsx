import { createFileRoute } from '@tanstack/react-router';
import { RunPage } from '../../features/reconciliation/run-page';

export const Route = createFileRoute('/_app/reconciliation/runs/$id')({
  component: RunRoute,
});

function RunRoute() {
  const { id } = Route.useParams();
  return <RunPage key={id} id={id} />;
}
