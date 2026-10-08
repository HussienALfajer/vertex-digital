import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Category, Game } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Gamepad2Icon,
  ImageIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { categoriesQuery, gamesQuery, useReorderGames } from './catalog.queries';
import { MoveButton, StatusBadge } from './catalog-parts';
import { type CatalogSearch, filtersOf, moved } from './catalog-search';
import { CategoriesDialog } from './categories-dialog';

/**
 * "الكتالوج" (S06 screens): category tabs, then the category's games as cards in their order, with
 * status and archive filters, a name search and move up / move down (rule CT5).
 */
export function CatalogPage({
  search,
  onSearch,
}: {
  search: CatalogSearch;
  onSearch: (search: CatalogSearch) => void;
}) {
  const { t } = useTranslation();
  const categories = useQuery(categoriesQuery());
  const [managing, setManaging] = useState(false);
  const list = categories.data ?? [];
  const current = list.find((category) => category.id === search.category) ?? list[0];

  return (
    <>
      <PageHeader
        title={t('catalog.title')}
        description={t('catalog.subtitle')}
        actions={
          <>
            <Button variant="outline" onClick={() => setManaging(true)}>
              <SettingsIcon />
              {t('catalog.categories.manage')}
            </Button>
            {current && (
              <Button render={<Link to="/catalog/games/new" search={{ category: current.id }} />}>
                <PlusIcon />
                {t('catalog.games.add')}
              </Button>
            )}
          </>
        }
      />
      {categories.isPending && <Skeleton className="h-11 w-full" aria-hidden="true" />}
      {categories.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, categories.error)}</FormAlert>
          <Button variant="outline" onClick={() => categories.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {categories.isSuccess && list.length === 0 && (
        <EmptyState
          icon={<Gamepad2Icon />}
          title={t('catalog.categories.none')}
          action={
            <Button onClick={() => setManaging(true)}>{t('catalog.categories.manage')}</Button>
          }
        />
      )}
      {current && (
        <>
          <Tabs
            value={current.id}
            onValueChange={(value) => onSearch({ ...filtersOf(search), category: String(value) })}
          >
            <TabsList>
              {list.map((category) => (
                <TabsTrigger key={category.id} value={category.id}>
                  {category.nameAr}
                  <Badge tone="neutral" className="tabular-nums">
                    {category.gameCount}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Filters search={search} onSearch={onSearch} />
          <Games category={current} search={search} />
        </>
      )}
      <Dialog open={managing} onOpenChange={setManaging}>
        {managing && <CategoriesDialog />}
      </Dialog>
    </>
  );
}

function Filters({
  search,
  onSearch,
}: {
  search: CatalogSearch;
  onSearch: (search: CatalogSearch) => void;
}) {
  const { t } = useTranslation();
  const statuses = [
    { value: 'all', label: t('catalog.filters.allStatuses') },
    { value: 'active', label: t('catalog.statuses.active') },
    { value: 'paused', label: t('catalog.statuses.paused') },
  ];
  const archive = [
    { value: 'live', label: t('catalog.filters.live') },
    { value: 'archived', label: t('catalog.filters.archived') },
  ];
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Select
        items={statuses}
        value={search.status ?? 'all'}
        onValueChange={(value) => {
          const { status: _previous, ...rest } = search;
          onSearch(value === 'active' || value === 'paused' ? { ...rest, status: value } : rest);
        }}
      >
        <SelectTrigger aria-label={t('catalog.filters.status')} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statuses.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={archive}
        value={search.archived ? 'archived' : 'live'}
        onValueChange={(value) => {
          const { archived: _previous, ...rest } = search;
          onSearch(value === 'archived' ? { ...rest, archived: true } : rest);
        }}
      >
        <SelectTrigger aria-label={t('catalog.filters.archive')} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {archive.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* A new key resets the field when the URL changes (clear, back). */}
      <SearchForm key={search.q ?? ''} search={search} onSearch={onSearch} />
    </div>
  );
}

function SearchForm({
  search,
  onSearch,
}: {
  search: CatalogSearch;
  onSearch: (search: CatalogSearch) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(search.q ?? '');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = text.trim();
    const { q: _previous, ...rest } = search;
    onSearch(q ? { ...rest, q } : rest);
  }

  return (
    <search className="w-full sm:w-auto">
      <form className="flex items-start gap-2" onSubmit={submit} noValidate>
        <Field className="flex-1 sm:w-64">
          <FieldLabel className="sr-only">{t('catalog.search.label')}</FieldLabel>
          <Input
            name="q"
            type="search"
            autoComplete="off"
            maxLength={60}
            placeholder={t('catalog.search.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline">
          <SearchIcon />
          {t('catalog.search.submit')}
        </Button>
      </form>
    </search>
  );
}

/** The games of the category; the move buttons only on the full unarchived list (rule CT5). */
function Games({ category, search }: { category: Category; search: CatalogSearch }) {
  const { t } = useTranslation();
  const filters = filtersOf(search);
  const games = useQuery(gamesQuery(category.id, filters));
  const reorder = useReorderGames(category.id);
  const [failure, setFailure] = useState<string | null>(null);
  const items = games.data?.items ?? [];
  const canReorder = !filters.status && !filters.archived && !filters.q;
  const filtered = !canReorder;

  async function move(index: number, step: -1 | 1) {
    setFailure(null);
    try {
      await reorder.mutateAsync(
        moved(
          items.map((game) => game.id),
          index,
          step,
        ),
      );
    } catch (error) {
      // Edge case 2: a stale list is refused; the list is read again on its own.
      setFailure(errorMessage(t, error));
    }
  }

  if (games.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((card) => (
          <Skeleton key={card} className="h-64 w-full" />
        ))}
      </div>
    );
  }
  if (games.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, games.error)}</FormAlert>
        <Button variant="outline" onClick={() => games.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return filtered ? (
      <EmptyState icon={<SearchIcon />} title={t('catalog.games.noMatch')} />
    ) : (
      <EmptyState
        icon={<Gamepad2Icon />}
        title={t('catalog.games.empty')}
        action={
          <Button render={<Link to="/catalog/games/new" search={{ category: category.id }} />}>
            <PlusIcon />
            {t('catalog.games.add')}
          </Button>
        }
      />
    );
  }
  return (
    <>
      {failure && <FormAlert>{failure}</FormAlert>}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((game, index) => (
          <li key={game.id}>
            <GameCard
              game={game}
              moves={
                canReorder
                  ? {
                      up: index > 0 ? () => move(index, -1) : undefined,
                      down: index < items.length - 1 ? () => move(index, 1) : undefined,
                      pending: reorder.isPending,
                    }
                  : undefined
              }
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function GameCard({
  game,
  moves,
}: {
  game: Game;
  moves?: { up?: () => void; down?: () => void; pending: boolean };
}) {
  const { t } = useTranslation();
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted">
        {game.cover ? (
          <img src={game.cover.url} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <Link
              to="/catalog/games/$id"
              params={{ id: game.id }}
              className="rounded-sm text-lg font-bold underline-offset-4 wrap-anywhere hover:underline"
            >
              {game.nameAr}
            </Link>
            <span dir="ltr" className="text-end text-sm text-muted-foreground">
              {game.nameEn}
            </span>
          </div>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <StatusBadge status={game.status} />
            {game.archivedAt && <Badge tone="warning">{t('catalog.archived')}</Badge>}
          </span>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            {t('catalog.games.productCount', { count: game.productCount })}
          </span>
          {moves && (
            <span className="flex gap-1">
              <MoveButton
                label={t('catalog.order.up', { name: game.nameAr })}
                onClick={moves.up}
                disabled={moves.pending}
              >
                <ArrowUpIcon />
              </MoveButton>
              <MoveButton
                label={t('catalog.order.down', { name: game.nameAr })}
                onClick={moves.down}
                disabled={moves.pending}
              >
                <ArrowDownIcon />
              </MoveButton>
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
