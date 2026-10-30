import { AscentLines } from '@vertex-digital/ui/brand/ascent-lines';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ChevronLeftIcon, StoreIcon } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';
import { SearchField } from '@/features/search/search-trigger';
import { t } from '@/lib/i18n';
import { CategoryCard } from './category-card';
import { getStorefront } from './data';
import { GameCard } from './game-card';
import { SCROLLER } from './scroller';

/** The hero (S09 screens): the title and the large search field (rule SR6). Static. */
export function HomeHero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <AscentLines className="absolute inset-y-0 end-0 h-full w-1/3 text-accent opacity-10" />
      {/* S21 PS1: in the sale mode (a merchant's, set before paint) only the search stays. */}
      <div className="relative mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 md:py-16 [[data-sale-mode-hint]_&]:py-4 [[data-sale-mode-hint]_&]:md:py-6">
        <h1 className="flex max-w-2xl items-start gap-3 text-3xl font-bold md:text-4xl [[data-sale-mode-hint]_&]:sr-only">
          <AscentBar className="mt-2 h-8 w-1.5" />
          {t('home.title')}
        </h1>
        <p className="max-w-2xl text-md text-muted-foreground [[data-sale-mode-hint]_&]:hidden">
          {t('home.subtitle')}
        </p>
        <SearchField />
      </div>
    </section>
  );
}

/** S24 NH1: how many games a category's row shows on the home page. */
const ROW_GAMES = 10;

/** The storefront's categories that show a game (rule SF1, S24 NH1). */
async function shownCategories() {
  await connection();
  const storefront = await getStorefront();
  return storefront.categories.filter((category) => category.games.length > 0);
}

/**
 * The categories first (owner, 2026-10-30): "تصفّح حسب الفئة" and one compact card per category
 * (a horizontal scroll on a phone, six columns from `lg`, three beside a merchant's sidebar until
 * `xl`). Read at request time (never at build, when the API may be away) from the `catalog` cache
 * (rule SF4); the rows below read the same cached storefront.
 */
export async function StorefrontCategories() {
  const categories = await shownCategories();
  if (categories.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <EmptyState icon={<StoreIcon />} title={t('catalog.empty')} />
      </div>
    );
  }
  return (
    <nav
      aria-labelledby="categories-title"
      className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pt-6"
    >
      <h2 id="categories-title" className="flex items-center gap-2 text-lg font-bold">
        <AscentBar className="h-5 w-1" />
        {t('catalog.browse')}
      </h2>
      <ul
        className={`${SCROLLER} sm:grid-cols-3 lg:grid-cols-6 [[data-merchant-hint]_&]:lg:grid-cols-3 [[data-merchant-hint]_&]:xl:grid-cols-6`}
      >
        {categories.map((category) => (
          <li key={category.slug} className="w-40 shrink-0 snap-start sm:w-auto">
            <CategoryCard category={category} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The categories' place while the storefront is read: no shift when the cards arrive. */
export function CategoriesSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pt-6" aria-hidden="true">
      <Skeleton className="h-6 w-40" />
      <div className="flex gap-3 overflow-hidden sm:grid sm:grid-cols-3 lg:grid-cols-6">
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <Skeleton key={key} className="h-40 w-40 shrink-0 sm:w-auto" />
        ))}
      </div>
    </div>
  );
}

/**
 * The games (S24 NH1): one row per category with its first games in panel order and "عرض الكل",
 * under the categories, the banners and "اشحن مجددًا".
 */
export async function StorefrontRows() {
  const categories = await shownCategories();
  if (categories.length === 0) return null;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
      {categories.map((category, section) => (
        <section
          key={category.slug}
          id={category.slug}
          aria-labelledby={`${category.slug}-title`}
          className="flex scroll-mt-4 flex-col gap-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id={`${category.slug}-title`} className="flex items-center gap-2 text-lg font-bold">
              <AscentBar className="h-5 w-1" />
              {category.nameAr}
            </h2>
            <Link
              href={`/categories/${category.slug}`}
              aria-label={t('catalog.viewAllOf', { name: category.nameAr })}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 text-sm font-medium text-accent-text underline-offset-4 hover:underline"
            >
              {t('catalog.viewAll')}
              <ChevronLeftIcon
                className="size-4 ltr:rotate-180"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </Link>
          </div>
          <ul className={`${SCROLLER} sm:grid-cols-3 lg:grid-cols-5`}>
            {category.games.slice(0, ROW_GAMES).map((game, index) => (
              <li key={game.id} className="w-36 shrink-0 snap-start sm:w-auto">
                {/* The first row is what a visitor sees first: its covers do not wait. */}
                <GameCard
                  game={game}
                  priority={section === 0 && index < 5}
                  sizes="(min-width: 64rem) 220px, (min-width: 40rem) 30vw, 144px"
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function StorefrontSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8" aria-hidden="true">
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {['a', 'b', 'c', 'd', 'e'].map((key) => (
          <Skeleton key={key} className="aspect-[3/4] w-full" />
        ))}
      </div>
    </div>
  );
}
