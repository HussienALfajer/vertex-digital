import { type ContentPage, parseRichText } from '@vertex-digital/contracts';
import { RichText } from '@vertex-digital/ui/components/rich-text';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageBackLink } from '@/components/page-back-link';
import { t } from '@/lib/i18n';
import { ContentLink } from './content-link';
import { getPublishedPage } from './data';
import { pageDescription, updatedText } from './texts';

/**
 * `/terms`, `/privacy`, `/refund`, `/about` (S14 PG2): the newest version with its title as the
 * only `h1`, "آخر تحديث" and the body through `RichText` in a readable column. Not found while
 * unpublished; a failed read shows the route's error view with a retry.
 */
export async function ContentPageView({ page }: { page: ContentPage }) {
  await connection();
  const data = await getPublishedPage(page);
  if (!data) notFound();
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-10 md:py-16">
      <PageBackLink href="/">{t('back.home')}</PageBackLink>
      <h1 className="text-3xl font-bold">{data.title}</h1>
      <p className="text-sm text-muted-foreground">{updatedText(data.updatedAt)}</p>
      <RichText
        blocks={parseRichText(data.body).blocks}
        link={ContentLink}
        className="mt-6 max-w-[70ch]"
      />
    </article>
  );
}

/**
 * The page's own title and a description from its first paragraph; "not found" with `noindex`
 * only while unpublished, the site's own title when the read failed (audit A08-40).
 */
export async function contentPageMetadata(page: ContentPage): Promise<Metadata> {
  await connection();
  const data = await getPublishedPage(page).catch(() => undefined);
  if (data === undefined) return {};
  if (data === null) return { title: t('notFound.title'), robots: { index: false } };
  return { title: data.title, description: pageDescription(parseRichText(data.body).blocks) };
}

export function ContentPageSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10 md:py-16"
      aria-hidden="true"
    >
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-6 h-64 w-full" />
    </div>
  );
}
