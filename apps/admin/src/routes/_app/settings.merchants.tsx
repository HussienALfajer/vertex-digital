import { createFileRoute } from '@tanstack/react-router';
import { MerchantSettingsPage } from '../../features/merchants/merchant-settings-page';

export const Route = createFileRoute('/_app/settings/merchants')({
  component: MerchantSettingsPage,
});
