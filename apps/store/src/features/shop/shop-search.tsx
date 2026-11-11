'use client';

import { Input } from '@vertex-digital/ui/components/input';
import { SearchIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { ts } from './i18n';
import { shopPath } from './paths';

type SearchGame = { slug: string; nameAr: string; nameEn: string };

/** Arabic and Latin letters folded so "ببجي" and "PUBG" match as typed. */
const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();

/**
 * The shop's search (S26 screens): the shop's own games only, filtered in the browser from the
 * cached home page; the store's search would list games the shop hides.
 */
export function ShopSearch({ slug, games }: { slug: string; games: SearchGame[] }) {
  const [query, setQuery] = useState('');
  const id = useId();
  const typed = fold(query);
  const found = typed
    ? games.filter((game) => fold(game.nameAr).includes(typed) || fold(game.nameEn).includes(typed))
    : [];
  return (
    <search className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        {ts('home.search')}
      </label>
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="search"
          value={query}
          placeholder={ts('home.search')}
          autoComplete="off"
          className="h-11 ps-10 text-md"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {typed && (
        <ul aria-live="polite" className="flex flex-col rounded-lg border border-border bg-surface">
          {found.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">{ts('home.searchEmpty')}</li>
          ) : (
            found.slice(0, 12).map((game) => (
              <li key={game.slug} className="border-b border-border last:border-b-0">
                <Link
                  href={shopPath(slug, `/games/${game.slug}`)}
                  className="flex min-h-11 items-center justify-between gap-3 px-4 py-2"
                >
                  <span className="font-medium">{game.nameAr}</span>
                  <span dir="ltr" className="text-sm text-muted-foreground">
                    {game.nameEn}
                  </span>
                </Link>
              </li>
            ))
          )}
        </ul>
      )}
    </search>
  );
}
