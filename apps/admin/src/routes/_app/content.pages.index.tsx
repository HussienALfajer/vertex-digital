import { createFileRoute } from '@tanstack/react-router';
import { PagesPage } from '../../features/content/pages-page';

export const Route = createFileRoute('/_app/content/pages/')({
  component: PagesPage,
});
