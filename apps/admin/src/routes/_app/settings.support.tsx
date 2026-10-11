import { createFileRoute } from '@tanstack/react-router';
import { SupportSettingsPage } from '../../features/support/support-settings-page';

export const Route = createFileRoute('/_app/settings/support')({
  component: SupportSettingsPage,
});
