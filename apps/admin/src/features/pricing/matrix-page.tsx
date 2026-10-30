import { useQueries, useQuery } from '@tanstack/react-query';
import {
  formatUsd,
  PRICE_MATRIX_MAX_LISTS,
  PRICE_MATRIX_STATUSES,
  type PriceMatrixCell,
  type PriceMatrixSort,
  type PriceMatrixStatus,
  ROOT_PRICE_LIST_IDS,
  type SupplierCode,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Pagination,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSortHead,
  ToggleGroup,
  ToggleGroupItem,
} from '@vertex-digital/ui';
import { Grid3x3Icon } from 'lucide-react';
import { Fragment, type Ref, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ReadFailure } from '../../components/read-failure';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { categoriesQuery } from '../catalog/catalog.queries';
import { ChosenGame, GamePicker } from '../catalog/game-picker';
import { purchaseGamesQuery } from '../orders/orders.queries';
import { FixedPriceDialog, SourceBadge } from './fixed-price-dialog';
import {
  clearMatrixFilters,
  hasMatrixFilters,
  type MatrixSearch,
  nextMatrixSort,
} from './matrix-search';
import { Picker } from './picker';
import { listRulesQuery, priceListsQuery, priceMatrixQuery } from './pricing.queries';
import { formatPercentBp, parsePercentBp } from './pricing-format';

const WARNING_TONES = {
  fallback: 'warning',
  capped: 'gold',
  above_parent: 'danger',
  held: 'info',
  unavailable: 'danger',
  no_row: 'neutral',
} as const;

/** The suppliers a basis route can be on in production. */
const SUPPLIERS: readonly SupplierCode[] = ['wdgzone', 'fazercards', 'manual'];

const LIST_SORTS: readonly PriceMatrixSort[] = ['price', 'margin', 'difference'];

/** A picker's or a chip's "everything". */
const ALL = 'all';

/** The sticky head's height, and the game rows stuck right under it. */
const HEAD_CLASS = 'sticky top-0 z-20 h-[4.5rem] bg-surface';
const GAME_ROW_CLASS = 'sticky top-[4.5rem] z-10 h-9 bg-muted font-bold text-foreground';

/** Not while typing: `/` is then a character; nor behind a dialog. */
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null;

/**
 * "مصفوفة الأسعار" (S20 screens): every game's packs in pages grouped by game, or a game's, by the
 * chosen lists, retail first; each cell its price, margin, source and warnings, a held pack's
 * target in a muted line. The filters, sort and page live in the URL and run on the server, so the
 * chips' counts always match the rows. A cell opens that list's fixed price for the pack.
 */
export function MatrixPage({
  search,
  onSearch,
}: {
  search: MatrixSearch;
  onSearch: (next: MatrixSearch) => void;
}) {
  const { t } = useTranslation();
  const games = useQuery(purchaseGamesQuery);
  const categories = useQuery(categoriesQuery());
  const lists = useQuery(priceListsQuery);
  const matrix = useQuery(priceMatrixQuery(search));
  const [opened, setOpened] = useState<{ listId: string; row: MatrixRow } | null>(null);
  const [pickingGame, setPickingGame] = useState(false);
  const listsId = useId();
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (typingIn(event.target)) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Any filter's change starts from the first page. */
  const filter = (next: MatrixSearch) => onSearch({ ...next, page: undefined });

  const live = (lists.data ?? []).filter(
    (list) => list.archivedAt === null && list.id !== ROOT_PRICE_LIST_IDS.retail,
  );
  const chosen = search.lists ?? [ROOT_PRICE_LIST_IDS.wholesale, ROOT_PRICE_LIST_IDS.cost];
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
    const gone = next.includes(id) ? null : id;
    filter({
      ...search,
      lists: next.slice(0, PRICE_MATRIX_MAX_LISTS - 1),
      // A list leaving the table takes its sort and its margin filter with it.
      ...(search.sortList === gone
        ? { sort: undefined, sortList: undefined, direction: undefined }
        : {}),
      ...(search.marginList === gone ? { marginList: undefined, marginBelowBp: undefined } : {}),
    });
  };
  const game = games.data?.games.find((item) => item.id === search.gameId);
  const retailName = lists.data?.find((list) => list.id === ROOT_PRICE_LIST_IDS.retail)?.name ?? '';
  const shownLists = [
    { value: ROOT_PRICE_LIST_IDS.retail as string, label: retailName },
    ...live
      .filter((list) => chosen.includes(list.id))
      .map((list) => ({ value: list.id, label: list.name })),
  ];
  const grouped = !search.gameId && !search.sort;
  const direction = (sort: PriceMatrixSort, listId?: string) =>
    search.sort === sort && search.sortList === listId ? (search.direction ?? 'asc') : null;
  const ariaSort = (listId: string) => {
    const sorted = search.sort && search.sort !== 'cost' && search.sortList === listId;
    if (!sorted) return undefined;
    return search.direction === 'desc' ? 'descending' : 'ascending';
  };
  const counts = matrix.data?.counts;

  return (
    <>
      <PageHeader title={t('pricing.matrix.title')} description={t('pricing.matrix.subtitle')} />
      <div className="flex flex-col gap-4">
        <div className="grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field>
            <FieldLabel render={<span />}>{t('pricing.matrix.game')}</FieldLabel>
            {game ? (
              <ChosenGame game={game} onChange={() => setPickingGame(true)} />
            ) : (
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => setPickingGame(true)}
              >
                {t('pricing.matrix.chooseGame')}
              </Button>
            )}
          </Field>
          <Field>
            <FieldLabel render={<span />}>{t('pricing.matrix.category')}</FieldLabel>
            <Picker
              label={t('pricing.matrix.category')}
              items={[
                { value: ALL, label: t('pricing.matrix.allCategories') },
                ...(categories.data ?? []).map((item) => ({ value: item.id, label: item.nameAr })),
              ]}
              value={search.categoryId ?? ALL}
              onChange={(value) =>
                filter({
                  ...search,
                  gameId: undefined,
                  categoryId: value === ALL ? undefined : value,
                })
              }
              read={categories}
            />
          </Field>
          <MatrixSearchForm search={search} onSearch={filter} inputRef={searchInput} />
          <Field>
            <FieldLabel render={<span />}>{t('pricing.matrix.supplier')}</FieldLabel>
            <Picker
              label={t('pricing.matrix.supplier')}
              items={[
                { value: ALL, label: t('pricing.matrix.allSuppliers') },
                ...SUPPLIERS.map((code) => ({ value: code, label: t(`suppliers.names.${code}`) })),
              ]}
              value={search.supplier ?? ALL}
              onChange={(value) =>
                filter({
                  ...search,
                  supplier: value === ALL ? undefined : (value as SupplierCode),
                })
              }
            />
          </Field>
        </div>
        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="mb-2 text-sm font-medium">{t('pricing.matrix.lists')}</legend>
          {lists.isError && <ReadFailure error={lists.error} onRetry={() => lists.refetch()} />}
          {live.map((list) => (
            <label
              key={list.id}
              htmlFor={`${listsId}-${list.id}`}
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id={`${listsId}-${list.id}`}
                checked={chosen.includes(list.id)}
                disabled={!chosen.includes(list.id) && chosen.length >= PRICE_MATRIX_MAX_LISTS - 1}
                onCheckedChange={() => toggle(list.id)}
              />
              {list.name}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-end gap-4">
          <MarginFilter
            search={search}
            onSearch={filter}
            lists={shownLists}
            key={search.marginBelowBp ?? 'none'}
          />
          {hasMatrixFilters(search) && (
            <Button variant="ghost" onClick={() => onSearch(clearMatrixFilters(search))}>
              {t('pricing.matrix.clear')}
            </Button>
          )}
        </div>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <ToggleGroup
            aria-label={t('pricing.matrix.statusLabel')}
            value={[search.status ?? ALL]}
            onValueChange={(value) => {
              const next = value[0];
              filter({
                ...search,
                status: !next || next === ALL ? undefined : (next as PriceMatrixStatus),
              });
            }}
          >
            {[ALL, ...PRICE_MATRIX_STATUSES].map((status) => (
              <ToggleGroupItem key={status} value={status}>
                {t(`pricing.matrix.statuses.${status as 'all' | PriceMatrixStatus}`)}
                {counts && (
                  <span className="ms-1.5 tabular-nums text-muted-foreground">
                    {counts[status as 'all' | PriceMatrixStatus]}
                  </span>
                )}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {matrix.isPending ? (
          <Skeleton className="h-64 w-full" aria-hidden="true" />
        ) : matrix.isError ? (
          <div className="flex flex-col items-start gap-3">
            <FormAlert>{errorMessage(t, matrix.error)}</FormAlert>
            <Button variant="outline" onClick={() => matrix.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : matrix.data.rows.length === 0 ? (
          <EmptyState
            icon={<Grid3x3Icon />}
            title={t('pricing.matrix.empty')}
            description={hasMatrixFilters(search) ? t('pricing.matrix.emptyHint') : undefined}
          />
        ) : (
          <>
            <Table
              // Audit A05-37: another game's or search's rows stay while the next load, dimmed.
              className={matrix.isPlaceholderData ? 'opacity-60' : undefined}
              containerClassName="max-h-[calc(100dvh-7rem)] overflow-y-auto"
              aria-busy={matrix.isPlaceholderData}
            >
              <TableHeader>
                <TableRow>
                  <TableHead className={HEAD_CLASS}>{t('pricing.columns.product')}</TableHead>
                  <TableSortHead
                    className={HEAD_CLASS}
                    direction={direction('cost', undefined)}
                    onSort={() => onSearch(nextMatrixSort(search, 'cost', undefined))}
                  >
                    {t('pricing.matrix.cost')}
                  </TableSortHead>
                  {matrix.data.lists.map((list) => (
                    <TableHead key={list.id} className={HEAD_CLASS} aria-sort={ariaSort(list.id)}>
                      <span className="block text-foreground">{list.name}</span>
                      <span className="flex gap-1 text-xs">
                        {LIST_SORTS.map((sort) => (
                          <SortButton
                            key={sort}
                            sort={sort}
                            list={list.name}
                            direction={direction(sort, list.id)}
                            onSort={() => onSearch(nextMatrixSort(search, sort, list.id))}
                          />
                        ))}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.data.rows.map((row, index) => (
                  <Fragment key={row.productId}>
                    {grouped && row.gameId !== matrix.data.rows[index - 1]?.gameId && (
                      <TableRow>
                        <TableHead
                          scope="rowgroup"
                          colSpan={matrix.data.lists.length + 2}
                          className={GAME_ROW_CLASS}
                        >
                          <bdi>{row.gameNameAr}</bdi>
                        </TableHead>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell className="whitespace-normal">
                        <span className="font-medium">{row.productNameAr}</span>
                        {!grouped && (
                          <span className="block text-xs text-muted-foreground">
                            {row.gameNameAr}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.costUsdUnits === null ? '—' : ltr(formatUsd(row.costUsdUnits))}
                      </TableCell>
                      {row.cells.map((cell) => (
                        <TableCell key={cell.priceListId} className="align-top">
                          <button
                            type="button"
                            disabled={matrix.isPlaceholderData}
                            className="flex w-full flex-col items-start gap-1 rounded-md p-1 text-start hover:bg-muted"
                            onClick={() => setOpened({ listId: cell.priceListId, row })}
                          >
                            {/* Audit A05-39: the price and warnings stay in the button's name. */}
                            <span className="sr-only">
                              {t('pricing.matrix.openCell', {
                                list: matrix.data.lists.find((list) => list.id === cell.priceListId)
                                  ?.name,
                                product: row.productNameAr,
                              })}
                            </span>
                            <MatrixCell cell={cell} />
                          </button>
                        </TableCell>
                      ))}
                    </TableRow>
                  </Fragment>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={matrix.data.page}
              pageCount={matrix.data.pageCount}
              onPageChange={(next) => onSearch({ ...search, page: next > 1 ? next : undefined })}
              summary={t('pricing.matrix.total', { total: matrix.data.total })}
              previousLabel={t('common.previous')}
              nextLabel={t('common.next')}
            />
          </>
        )}
      </div>
      <Dialog open={pickingGame} onOpenChange={setPickingGame}>
        {pickingGame && (
          <DialogContent className="sm:max-w-3xl" closeLabel={t('common.close')}>
            <DialogHeader>
              <DialogTitle>{t('pricing.matrix.chooseGame')}</DialogTitle>
            </DialogHeader>
            <div className="max-h-[70dvh] overflow-y-auto p-0.5">
              <GamePicker
                focus
                onPick={(gameId) => {
                  setPickingGame(false);
                  filter({ ...search, gameId, categoryId: undefined, q: undefined });
                }}
                onCancel={() => setPickingGame(false)}
              />
            </div>
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={!!opened} onOpenChange={(open) => !open && setOpened(null)}>
        {opened && lists.data && (
          <CellDialog
            listId={opened.listId}
            row={opened.row}
            chain={lists.data.find((list) => list.id === opened.listId)?.chain ?? [opened.listId]}
            onDone={() => setOpened(null)}
          />
        )}
      </Dialog>
    </>
  );
}

/** One of a list column's sorts; the arrow marks the one in force. */
function SortButton({
  sort,
  list,
  direction,
  onSort,
}: {
  sort: PriceMatrixSort;
  list: string;
  direction: 'asc' | 'desc' | null;
  onSort: () => void;
}) {
  const { t } = useTranslation();
  const column = t(`pricing.matrix.sorts.${sort as 'price' | 'margin' | 'difference'}`);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-6 px-1 text-xs ${direction ? 'font-bold text-foreground' : 'font-normal'}`}
      aria-label={t('pricing.matrix.sortBy', { list, column })}
      onClick={onSort}
    >
      {column}
      {direction === 'asc' && ' ↑'}
      {direction === 'desc' && ' ↓'}
    </Button>
  );
}

/**
 * The search box on its own: typing re-renders this form, not the whole table (audit A05-38). It
 * follows the URL on back and forward.
 */
function MatrixSearchForm({
  search,
  onSearch,
  inputRef,
}: {
  search: MatrixSearch;
  onSearch: (next: MatrixSearch) => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => setQ(search.q ?? ''), [search.q]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const text = q.trim();
        onSearch({
          ...search,
          q: text || undefined,
          gameId: text ? undefined : search.gameId,
        });
      }}
    >
      <Field>
        <FieldLabel>{t('pricing.matrix.search')}</FieldLabel>
        <Input
          ref={inputRef}
          name="q"
          placeholder={t('pricing.matrix.searchPlaceholder')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
      </Field>
    </form>
  );
}

/** "الهامش أقل من" on one shown list; a typed percent applies on Enter or on leaving the field. */
function MarginFilter({
  search,
  onSearch,
  lists,
}: {
  search: MatrixSearch;
  onSearch: (next: MatrixSearch) => void;
  lists: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(
    search.marginBelowBp === undefined ? '' : formatPercentBp(search.marginBelowBp),
  );
  const typed = text.trim() === '' ? undefined : parsePercentBp(text);
  const invalid = typed === null || typed === 0;
  const apply = () => {
    if (!invalid && typed !== search.marginBelowBp) onSearch({ ...search, marginBelowBp: typed });
  };
  return (
    <>
      <Field className="w-44">
        <FieldLabel render={<span />}>{t('pricing.matrix.marginList')}</FieldLabel>
        <Picker
          label={t('pricing.matrix.marginList')}
          items={lists}
          value={search.marginList ?? ROOT_PRICE_LIST_IDS.retail}
          onChange={(value) =>
            onSearch({
              ...search,
              marginList: value === ROOT_PRICE_LIST_IDS.retail ? undefined : value,
            })
          }
        />
      </Field>
      <form
        className="w-44"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <Field invalid={invalid}>
          <FieldLabel>{t('pricing.matrix.marginBelow')}</FieldLabel>
          <Input
            name="marginBelow"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={apply}
          />
          <FieldError match={invalid}>{t('pricing.matrix.marginInvalid')}</FieldError>
        </Field>
      </form>
    </>
  );
}

type MatrixRow = {
  productId: string;
  productNameAr: string;
  gameId: string;
  cells: PriceMatrixCell[];
};

/** The fixed price dialog of the cell's list, once the chain's rules are read. */
function CellDialog({
  listId,
  row,
  chain,
  onDone,
}: {
  listId: string;
  row: MatrixRow;
  chain: string[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const reads = useQueries({ queries: chain.map((id) => listRulesQuery(id)) });
  const cell = row.cells.find((candidate) => candidate.priceListId === listId);
  // Audit A05-9: the wait and a failed read show inside the dialog, with a retry.
  if (reads.some((read) => !read.isSuccess)) {
    const failed = reads.find((read) => read.isError);
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <bdi>{row.productNameAr}</bdi>
          </DialogTitle>
        </DialogHeader>
        {failed ? (
          <div className="flex flex-col items-start gap-3">
            <FormAlert>{errorMessage(t, failed.error)}</FormAlert>
            <Button
              variant="outline"
              onClick={() => {
                for (const read of reads) if (read.isError) read.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <Skeleton className="h-64 w-full" aria-hidden="true" />
        )}
      </DialogContent>
    );
  }
  return (
    <FixedPriceDialog
      listId={listId}
      chain={chain}
      rules={reads.flatMap((read) => read.data ?? [])}
      initial={{
        gameId: row.gameId,
        productId: row.productId,
        priceUsdUnits: cell?.fixedPriceUsdUnits ?? null,
      }}
      rulesLink
      onDone={onDone}
    />
  );
}

function MatrixCell({ cell }: { cell: PriceMatrixCell }) {
  const { t } = useTranslation();
  return (
    <>
      {cell.priceUsdUnits === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="font-bold tabular-nums">{ltr(formatUsd(cell.priceUsdUnits))}</span>
      )}
      {cell.marginUsdUnits !== null && cell.marginBp !== null && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {ltr(`${formatUsd(cell.marginUsdUnits)} · ${formatPercentBp(cell.marginBp)}%`)}
        </span>
      )}
      {cell.targetPriceUsdUnits !== null && (
        <span className="text-xs text-muted-foreground">
          {t('pricing.matrix.target', { price: ltr(formatUsd(cell.targetPriceUsdUnits)) })}
        </span>
      )}
      <span className="flex flex-wrap gap-1">
        {cell.source && cell.source !== 'rule' && <SourceBadge source={cell.source} />}
        {cell.warnings
          .filter((warning) => warning !== 'fallback' && warning !== 'capped')
          .map((warning) => (
            <Badge key={warning} tone={WARNING_TONES[warning]}>
              {t(`pricing.matrix.warnings.${warning}`)}
            </Badge>
          ))}
      </span>
    </>
  );
}
