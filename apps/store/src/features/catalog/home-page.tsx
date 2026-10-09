import { AscentLines } from '@vertex-digital/ui/brand/ascent-lines';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { StoreIcon } from 'lucide-react';
import { connection } from 'next/server';
import { SearchField } from '@/features/search/search-trigger';
import { t } from '@/lib/i18n';
import { getStorefront } from './data';
import { GameCard } from './game-card';
import { ServiceLine } from './service-status';

/** The hero (S09 screens): the title and the large search field (rule SR6). Static. */
export function HomeHero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <AscentLines className="absolute inset-y-0 end-0 h-full w-1/3 text-accent opacity-10" />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 md:py-16">
        <h1 className="flex max-w-2xl items-start gap-3 text-3xl font-bold md:text-4xl">
          <AscentBar className="mt-2 h-8 w-1.5" />
          {t('home.title')}
        </h1>
        <p className="max-w-2xl text-md text-muted-foreground">{t('home.subtitle')}</p>
        <SearchField />
      </div>
    </section>
  );
}

/**
 * The catalog (rules SF1, SS2): the service line, the category jump chips and one section per
 * category with its games, 2 columns at 360 px, 3 from `sm`, 5 from `lg`. Read at request time
 * (never at build, when the API may be away) from the `catalog` cache (rule SF4).
 */
export async function StorefrontSections() {
  await connection();
  const storefront = await getStorefront();
  const categories = storefront.categories.filter((category) => category.games.length > 0);
  if (categories.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <EmptyState icon={<StoreIcon />} title={t('catalog.empty')} />
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
      <div className="flex flex-col gap-4">
        <ServiceLine service={storefront.service} />
        <nav aria-label={t('catalog.categories')}>
          <ul className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <li key={category.slug}>
                <a
                  href={`#${category.slug}`}
                  className="inline-flex h-11 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium hover:bg-muted"
                >
                  {category.nameAr}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {categories.map((category) => (
        <section
          key={category.slug}
          id={category.slug}
          aria-labelledby={`${category.slug}-title`}
          className="flex scroll-mt-4 flex-col gap-4"
        >
          <h2 id={`${category.slug}-title`} className="flex items-center gap-2 text-lg font-bold">
            <AscentBar className="h-5 w-1" />
            {category.nameAr}
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {category.games.map((game) => (
              <li key={game.id}>
                <GameCard game={game} />
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
