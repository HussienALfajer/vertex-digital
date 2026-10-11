import { createFileRoute, notFound } from '@tanstack/react-router';
import { CONTENT_PAGES, type ContentPage } from '@vertex-digital/contracts';
import { PageEditor } from '../../features/content/page-editor';

/** One of the four fixed pages (S14 PG1); any other name is not found. */
export const Route = createFileRoute('/_app/content/pages/$page')({
  params: {
    parse: ({ page }) => {
      if (!(CONTENT_PAGES as readonly string[]).includes(page)) throw notFound();
      return { page: page as ContentPage };
    },
    stringify: ({ page }) => ({ page }),
  },
  component: PageRoute,
});

function PageRoute() {
  const { page } = Route.useParams();
  // A new key resets the editor's copy when another page opens.
  return <PageEditor key={page} page={page} />;
}
