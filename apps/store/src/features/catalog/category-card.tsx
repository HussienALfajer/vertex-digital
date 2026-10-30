import { VertexMark } from '@vertex-digital/ui/brand/logo';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { CatalogPicture } from './catalog-picture';
import type { StoreCategory } from './game-card';

/** Rule NH2: the category's image, else its first 3 covers, else the Vertex mark. */
function CategoryArt({ category }: { category: StoreCategory }): ReactNode {
  if (category.image) {
    return (
      <CatalogPicture
        image={category.image}
        sizes="(min-width: 64rem) 220px, (min-width: 40rem) 30vw, 176px"
        className="aspect-[3/2] w-full"
      />
    );
  }
  const covers = category.games.flatMap((game) => (game.cover ? [game.cover] : [])).slice(0, 3);
  if (covers.length === 0) {
    return (
      <span className="flex aspect-[3/2] w-full items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
        <VertexMark className="w-12" />
      </span>
    );
  }
  return (
    <span
      className={`grid aspect-[3/2] w-full gap-1 overflow-hidden rounded-lg border border-border bg-muted p-1 ${
        covers.length === 1 ? 'grid-cols-1' : covers.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
      }`}
    >
      {covers.map((cover) => (
        <CatalogPicture
          key={cover.id}
          image={cover}
          sizes="96px"
          className="h-full min-h-0 w-full rounded-md border-0"
        />
      ))}
    </span>
  );
}

/** A category on the home page (S24 NH1): its art, name and game count, linking to its page. */
export function CategoryCard({ category }: { category: StoreCategory }) {
  return (
    <Link
      href={`/categories/${category.slug}`}
      className="flex h-full flex-col gap-2 rounded-lg border border-border bg-surface p-2 transition-colors duration-150 hover:border-accent focus-visible:border-accent"
    >
      <CategoryArt category={category} />
      <span className="flex items-baseline justify-between gap-2 px-1 pb-1">
        <span className="font-bold break-words">{category.nameAr}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {t('catalog.gameCount', { count: category.games.length })}
        </span>
      </span>
    </Link>
  );
}
