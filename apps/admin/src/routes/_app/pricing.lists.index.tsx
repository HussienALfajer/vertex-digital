import { createFileRoute } from '@tanstack/react-router';
import { PriceListsPage } from '../../features/pricing/price-lists-page';

export const Route = createFileRoute('/_app/pricing/lists/')({
  component: PriceListsPage,
});
