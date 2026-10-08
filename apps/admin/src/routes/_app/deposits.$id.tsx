import { createFileRoute } from '@tanstack/react-router';
import { DepositPage } from '../../features/deposits/deposit-page';

export const Route = createFileRoute('/_app/deposits/$id')({
  component: DepositRoute,
});

function DepositRoute() {
  const { id } = Route.useParams();
  // A new key resets the page's forms and dialogs when another deposit opens.
  return <DepositPage key={id} id={id} />;
}
