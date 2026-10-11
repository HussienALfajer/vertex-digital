import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ContentLayout } from '../../features/content/content-layout';

export const Route = createFileRoute('/_app/content')({
  component: () => (
    <ContentLayout>
      <Outlet />
    </ContentLayout>
  ),
});
