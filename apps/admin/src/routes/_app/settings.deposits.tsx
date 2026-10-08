import { createFileRoute } from '@tanstack/react-router';
import { DepositSettingsPage } from '../../features/deposits/deposit-settings-page';

export const Route = createFileRoute('/_app/settings/deposits')({
  component: DepositSettingsPage,
});
