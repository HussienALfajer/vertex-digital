import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CategoryPage, categoryOf } from '@/features/catalog/category-page';
import { StorefrontSkeleton } from '@/features/catalog/home-page';
import { t } from '@/lib/i18n';
import { storeUrl } from '@/lib/server-env';

type Props = { params: Promise<{ slug: string }> };

/** As SF6: its own title and description, one address for search engines. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = await categoryOf(slug);
  if (!category) return { title: t('notFound.title'), robots: { index: false } };
  const description = t('catalog.categoryDescription', { name: category.nameAr });
  return {
    title: { absolute: t('catalog.categoryMetaTitle', { name: category.nameAr }) },
    description,
    alternates: { canonical: `${storeUrl()}/categories/${category.slug}` },
    openGraph: { title: t('catalog.categoryMetaTitle', { name: category.nameAr }), description },
  };
}

/** A category's page (S24 NH3): the slug is known at request time, the data is the cached catalog. */
export default function CategoryRoute({ params }: Props) {
  return (
    <Suspense fallback={<StorefrontSkeleton />}>
      <CategoryPage params={params} />
    </Suspense>
  );
}
