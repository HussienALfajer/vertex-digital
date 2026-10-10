import { createFileRoute } from '@tanstack/react-router';
import { TicketPage } from '../../features/support/ticket-page';

export const Route = createFileRoute('/_app/support/$id')({
  component: TicketRoute,
});

function TicketRoute() {
  const { id } = Route.useParams();
  // A new key resets the reply box when another ticket opens.
  return <TicketPage key={id} id={id} />;
}
