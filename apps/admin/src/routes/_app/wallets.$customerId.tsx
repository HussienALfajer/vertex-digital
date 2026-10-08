import { createFileRoute } from '@tanstack/react-router';
import { WalletPage } from '../../features/wallet/wallet-page';

export const Route = createFileRoute('/_app/wallets/$customerId')({
  component: WalletRoute,
});

function WalletRoute() {
  const { customerId } = Route.useParams();
  // A new key resets the page's dialogs when another wallet opens.
  return <WalletPage key={customerId} customerId={customerId} />;
}
