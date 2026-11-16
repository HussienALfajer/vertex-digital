import { createFileRoute } from '@tanstack/react-router';
import { RateSettingsPage } from '../../features/rates/rate-settings-page';

export const Route = createFileRoute('/_app/rates/settings')({
  component: RateSettingsPage,
});
