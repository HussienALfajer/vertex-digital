import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '../../features/content/activity-page';

export const Route = createFileRoute('/_app/content/activity')({
  component: ActivityPage,
});
