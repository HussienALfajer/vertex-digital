import { createFileRoute, redirect } from '@tanstack/react-router';

/** "المحتوى" opens on its first tab. */
export const Route = createFileRoute('/_app/content/')({
  beforeLoad: () => {
    throw redirect({ to: '/content/pages', replace: true });
  },
});
