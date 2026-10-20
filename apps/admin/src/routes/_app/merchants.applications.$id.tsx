import { createFileRoute } from '@tanstack/react-router';
import { ApplicationPage } from '../../features/merchants/application-page';

export const Route = createFileRoute('/_app/merchants/applications/$id')({
  component: ApplicationRoute,
});

function ApplicationRoute() {
  const { id } = Route.useParams();
  // A new key resets the dialogs when another application opens.
  return <ApplicationPage key={id} id={id} />;
}
