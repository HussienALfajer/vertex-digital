import { createFileRoute } from '@tanstack/react-router';
import { MerchantTiersPage } from '../../features/merchants/tiers-page';

export const Route = createFileRoute('/_app/merchants/tiers')({
  component: MerchantTiersPage,
});
