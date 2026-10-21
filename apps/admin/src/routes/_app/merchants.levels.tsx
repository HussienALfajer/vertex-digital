import { createFileRoute } from '@tanstack/react-router';
import { MerchantLevelsPage } from '../../features/merchants/levels-page';

export const Route = createFileRoute('/_app/merchants/levels')({
  component: MerchantLevelsPage,
});
