import { createFileRoute } from '@tanstack/react-router';
import { NewTicketPage } from '../../features/support/new-ticket-page';
import { parseNewTicketSearch } from '../../features/support/support-search';

/** `?customer=`: the customer the ticket is for (TK2), from the profile's actions. */
export const Route = createFileRoute('/_app/support/new')({
  validateSearch: parseNewTicketSearch,
  component: NewTicketRoute,
});

function NewTicketRoute() {
  const { customer } = Route.useSearch();
  return <NewTicketPage key={customer ?? ''} customerId={customer} />;
}
