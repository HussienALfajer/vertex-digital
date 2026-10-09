'use client';

import {
  formatSyp,
  formatUsd,
  type SearchIndex,
  type SearchIndexGame,
  type SearchIndexProduct,
  searchCatalog,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { CommandDialogContent } from '@vertex-digital/ui/components/command-dialog';
import { Dialog, DialogClose, DialogTitle } from '@vertex-digital/ui/components/dialog';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ClockIcon, Gamepad2Icon, PackageIcon, SearchIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import { clearRecentSearches, readRecentSearches, rememberSearch } from './recent';
import { getSearchIndex } from './requests';

type IndexState =
  | { status: 'loading' }
  | { status: 'failed'; reason: Parameters<typeof errorText>[0] }
  | { status: 'ready'; index: SearchIndex };

/** One row of the results, in the order the arrow keys walk them. */
type Option =
  | { kind: 'game'; game: SearchIndexGame; href: string }
  | { kind: 'product'; product: SearchIndexProduct; gameName: string; href: string }
  | { kind: 'recent'; query: string };

// The index stays for the page's life: a second open needs no request.
let cachedIndex: SearchIndex | null = null;

/**
 * The search dialog (S09 rule SR5): a full-screen sheet on phones, a dialog from `sm`. Results
 * update as the customer types (rules SR3, SR4 in the browser, over the public index); arrows,
 * `Enter` and `Esc` work. A game opens its page, a pack its game page with `?pack=<id>`. An empty
 * query lists the recent searches of this device.
 */
export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const listId = useId();
  const [state, setState] = useState<IndexState>(
    cachedIndex ? { status: 'ready', index: cachedIndex } : { status: 'loading' },
  );
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setRecent(readRecentSearches());
    if (cachedIndex) return;
    let live = true;
    void getSearchIndex().then((result) => {
      if (!live) return;
      if (!result.ok) return setState({ status: 'failed', reason: result.reason });
      cachedIndex = result.data;
      setState({ status: 'ready', index: result.data });
    });
    return () => {
      live = false;
    };
  }, [open]);

  const results = useMemo(
    () =>
      state.status === 'ready' ? searchCatalog(state.index, query) : { games: [], products: [] },
    [state, query],
  );
  const gameNames = useMemo(
    () =>
      new Map(
        state.status === 'ready' ? state.index.games.map((game) => [game.slug, game.nameAr]) : [],
      ),
    [state],
  );

  const options: Option[] = query.trim()
    ? [
        ...results.games.map(
          (game): Option => ({ kind: 'game', game, href: `/games/${game.slug}` }),
        ),
        ...results.products.map(
          (product): Option => ({
            kind: 'product',
            product,
            gameName: gameNames.get(product.gameSlug) ?? '',
            href: `/games/${product.gameSlug}?pack=${product.id}`,
          }),
        ),
      ]
    : recent.map((item): Option => ({ kind: 'recent', query: item }));
  const current = Math.min(active, Math.max(0, options.length - 1));

  function choose(option: Option) {
    if (option.kind === 'recent') {
      setQuery(option.query);
      setActive(0);
      return;
    }
    setRecent(rememberSearch(query));
    setQuery('');
    setActive(0);
    onOpenChange(false);
    router.push(option.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (options.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[current] as Option);
    }
  }

  const optionId = (index: number) => `${listId}-${index}`;
  const trimmed = query.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setQuery('');
          setActive(0);
        }
      }}
    >
      <CommandDialogContent aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border p-2">
          <SearchIcon className="ms-2 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length > 0 ? optionId(current) : undefined}
            aria-label={t('search.title')}
            className="h-11 min-w-0 flex-1 bg-transparent text-md outline-none placeholder:text-muted-foreground"
            placeholder={t('search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={100}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <DialogClose
            render={<Button variant="ghost" size="xl" className="px-3" />}
            aria-label={t('search.close')}
          >
            <XIcon />
          </DialogClose>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {state.status === 'loading' && (
            <div className="flex flex-col gap-2 p-2" aria-hidden="true">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {state.status === 'failed' && (
            <p className="p-4 text-sm text-destructive-text" role="alert">
              {errorText(state.reason)}
            </p>
          )}
          {state.status === 'ready' && !trimmed && recent.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">{t('search.hint')}</p>
          )}
          {state.status === 'ready' && !trimmed && recent.length > 0 && (
            <div className="flex items-center justify-between px-2 pt-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t('search.recent')}</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  clearRecentSearches();
                  setRecent([]);
                }}
              >
                {t('search.clearRecent')}
              </Button>
            </div>
          )}
          {state.status === 'ready' && trimmed && options.length === 0 && (
            <div className="flex flex-col items-start gap-3 p-4">
              <p className="text-base">{t('search.noResults', { query: trimmed })}</p>
              <Button
                variant="outline"
                size="xl"
                render={<Link href="/" onClick={() => onOpenChange(false)} />}
              >
                {t('search.home')}
              </Button>
            </div>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label={t('search.results')}
            className="flex flex-col"
          >
            {options.map((option, index) => (
              <div
                key={optionKey(option)}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                tabIndex={-1}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(option)}
                onKeyDown={() => undefined}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 ${index === current ? 'bg-muted' : ''} ${isUnavailable(option) ? 'opacity-60' : ''}`}
              >
                <OptionRow option={option} />
              </div>
            ))}
          </div>
        </div>
      </CommandDialogContent>
    </Dialog>
  );
}

function optionKey(option: Option): string {
  if (option.kind === 'game') return `game:${option.game.id}`;
  if (option.kind === 'product') return `product:${option.product.id}`;
  return `recent:${option.query}`;
}

function isUnavailable(option: Option): boolean {
  if (option.kind === 'game') return option.game.status === 'unavailable';
  if (option.kind === 'product') return !option.product.available;
  return false;
}

function OptionRow({ option }: { option: Option }) {
  if (option.kind === 'recent') {
    return (
      <>
        <ClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <bdi className="text-base">{option.query}</bdi>
      </>
    );
  }
  if (option.kind === 'game') {
    const { game } = option;
    return (
      <>
        {game.cover ? (
          <CatalogPicture image={game.cover} sizes="40px" className="size-10 shrink-0" />
        ) : (
          <Gamepad2Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{game.nameAr}</span>
          <span className="truncate text-xs text-muted-foreground">
            {game.categoryNameAr} · <bdi dir="ltr">{game.nameEn}</bdi>
          </span>
        </span>
        {game.status === 'unavailable' && (
          <span className="text-xs text-muted-foreground">{t('catalog.status.unavailable')}</span>
        )}
      </>
    );
  }
  const { product, gameName } = option;
  return (
    <>
      <PackageIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <bdi className="truncate font-medium">{product.nameAr}</bdi>
        <span className="truncate text-xs text-muted-foreground">{gameName}</span>
      </span>
      {product.available && product.priceUsdUnits !== null ? (
        <span className="flex shrink-0 flex-col items-end">
          <bdi dir="ltr" className="font-bold tabular-nums">
            {formatUsd(product.priceUsdUnits)}
          </bdi>
          {product.priceSypUnits !== null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('catalog.price.syp', { amount: formatSyp(product.priceSypUnits) })}
            </span>
          )}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t('catalog.status.unavailable')}</span>
      )}
    </>
  );
}
