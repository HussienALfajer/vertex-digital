import { AscentLines } from '@vertex-digital/ui/brand/ascent-lines';
import { VertexMark } from '@vertex-digital/ui/brand/logo';
import { ChevronLeftIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { tc } from '@/lib/i18n';
import { CatalogPicture } from './catalog-picture';
import type { StoreCategory } from './game-card';

/**
 * Rule NH2 (owner, 2026-10-30): the category's own image, landscape 3:2; without one, up to three
 * of its covers whole and square over the 60° lines (never cropped into slices); with no cover,
 * the Vertex mark.
 */
function CategoryArt({ category }: { category: StoreCategory }): ReactNode {
  if (category.image) {
    return (
      <CatalogPicture
        image={category.image}
        sizes="(min-width: 64rem) 200px, (min-width: 40rem) 30vw, 160px"
        className="aspect-[3/2] w-full"
      />
    );
  }
  const covers = category.games.flatMap((game) => (game.cover ? [game.cover] : [])).slice(0, 3);
  return (
    <span
      aria-hidden="true"
      className="relative flex aspect-[3/2] w-full items-center justify-center gap-2 overflow-hidden rounded-lg border border-border bg-surface px-3"
    >
      <AscentLines className="absolute inset-y-0 end-0 h-full w-2/3 text-accent opacity-20" />
      {covers.length === 0 ? (
        <VertexMark className="relative w-10 text-primary" />
      ) : (
        covers.map((cover) => (
          <CatalogPicture
            key={cover.id}
            image={cover}
            sizes="64px"
            className="relative aspect-square w-1/4 max-w-16 shrink-0"
          />
        ))
      )}
    </span>
  );
}

/**
 * A category on the home page (S24 NH1; owner, 2026-10-30): built so it never reads as a game
 * card: landscape art, a sand border on the quiet green surface, its name with the count of its
 * items, and a chevron. Compact: it leads the page above the games.
 */
export function CategoryCard({ category }: { category: StoreCategory }) {
  return (
    <Link
      href={`/categories/${category.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-accent bg-surface-brand transition-colors duration-150 hover:border-accent-text focus-visible:border-accent-text"
    >
      <span className="p-1.5 pb-0">
        <CategoryArt category={category} />
      </span>
      <span className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-bold">{category.nameAr}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {tc('catalog.itemCount', category.games.length)}
          </span>
        </span>
        <ChevronLeftIcon
          className="size-4 shrink-0 text-accent-text transition-transform duration-150 group-hover:-translate-x-0.5 ltr:rotate-180"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </span>
    </Link>
  );
}
