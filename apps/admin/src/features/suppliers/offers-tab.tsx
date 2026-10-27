import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  MAX_IMPORT_ROWS,
  type SupplierDetail,
  type SupplierOffer,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vertex-digital/ui';
import {
  EyeIcon,
  EyeOffIcon,
  HistoryIcon,
  Link2Icon,
  PackageSearchIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatSince } from '../../lib/format';
import { CostHistoryDialog } from './cost-history-dialog';
import { ImportDialog } from './import-dialog';
import { LinkOfferDialog } from './link-offer-dialog';
import { LastSeen, OfferCost, OfferFields, OfferMarks, StockChip } from './offer-cells';
import type { OfferSearch } from './supplier-search';
import { categoryQuery, LIST_PAGE_SIZE, offersQuery, useOfferIgnored } from './suppliers.queries';
import { TipButton } from './tip-button';

type FlagName =
  | 'mapped'
  | 'inStock'
  | 'missing'
  | 'supported'
  | 'ignored'
  | 'lowStock'
  | 'discounted';

const ALL = 'all';

/**
 * "العروض" (S07 screens, S16 SF1): the supplier's offers with their cost and its freshness, the
 * original price and discount, stock, fields, support and mapping; filters and search in the
 * URL; offers selected across pages and imported into a game (rule RT8); an offer's cost history;
 * ignore and unignore (SC6). `manual` lists the manual offers with their products.
 */
export function OffersTab(props: {
  supplier: SupplierDetail;
  search: OfferSearch;
  onSearch: (next: OfferSearch) => void;
}) {
  return <OffersBrowser {...props} />;
}

/**
 * The offers table shared by the offers tab and a category page (S18): filters, selection across
 * pages (a page at once too), the import, the cost history, ignore, and the link to an existing
 * pack. With `categoryId` the list stays inside that category: its filter is no chip to clear.
 */
export function OffersBrowser({
  supplier,
  search,
  onSearch,
  categoryId,
}: {
  supplier: SupplierDetail;
  search: OfferSearch;
  onSearch: (next: OfferSearch) => void;
  categoryId?: string;
}) {
  const { t } = useTranslation();
  const scoped = categoryId ? { ...search, categoryId } : search;
  const offers = useQuery(offersQuery(supplier.code, scoped));
  const [selected, setSelected] = useState<Map<string, SupplierOffer>>(new Map());
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<SupplierOffer | null>(null);
  const [linking, setLinking] = useState<SupplierOffer | null>(null);
  const ignore = useOfferIgnored();
  const [failure, setFailure] = useState<string | null>(null);
  const manual = supplier.code === 'manual';
  const filtered = Object.keys(scoped).some(
    (name) => name !== 'page' && !(categoryId && name === 'categoryId'),
  );
  const page = search.page ?? 1;
  const total = offers.data?.total;
  const pageCount = Math.max(1, Math.ceil((total ?? 0) / LIST_PAGE_SIZE));
  // A page past the end (its last offers imported, an old link) shows the last page (A05-26).
  useEffect(() => {
    if (total !== undefined && total > 0 && page > pageCount) {
      onSearch({ ...search, page: pageCount > 1 ? pageCount : undefined });
    }
  }, [total, page, pageCount, search, onSearch]);

  const set = (next: OfferSearch) => onSearch({ ...search, ...next, page: undefined });
  const selectable = (offer: SupplierOffer) =>
    !manual && !offer.mapped && !offer.missingSince && !offer.unsupportedReason && !offer.ignoredAt;
  const linkable = (offer: SupplierOffer) =>
    !manual && !offer.missingSince && !offer.unsupportedReason;
  const pageRows = (offers.data?.items ?? []).filter(selectable);
  const pageSelected = pageRows.length > 0 && pageRows.every((offer) => selected.has(offer.id));

  async function setIgnored(offer: SupplierOffer, ignored: boolean) {
    setFailure(null);
    try {
      await ignore.mutateAsync({ id: offer.id, ignored });
      if (ignored) toggle(offer, false);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }
  const toggle = (offer: SupplierOffer, on: boolean) =>
    setSelected((previous) => {
      const next = new Map(previous);
      if (on && next.size < MAX_IMPORT_ROWS) next.set(offer.id, offer);
      else next.delete(offer.id);
      return next;
    });
  /** S18: the page's selectable offers at once, as far as the import's limit allows. */
  const togglePage = (on: boolean) =>
    setSelected((previous) => {
      const next = new Map(previous);
      for (const offer of pageRows) {
        if (!on) next.delete(offer.id);
        else if (next.size < MAX_IMPORT_ROWS) next.set(offer.id, offer);
      }
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <Filters
        supplier={supplier}
        search={search}
        manual={manual}
        categoryLocked={categoryId !== undefined}
        onSearch={set}
        onClear={() => onSearch({})}
      />
      {!manual && selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
          <span className="text-sm font-medium tabular-nums">
            {t('suppliers.offers.selected', { count: selected.size, max: MAX_IMPORT_ROWS })}
          </span>
          <span className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setSelected(new Map())}>
              {t('suppliers.offers.clearSelection')}
            </Button>
            <Button onClick={() => setImporting(true)}>{t('suppliers.offers.import')}</Button>
          </span>
        </div>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      {offers.isPending && <Skeleton className="h-96 w-full" aria-hidden="true" />}
      {offers.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, offers.error)}</FormAlert>
          <Button variant="outline" onClick={() => offers.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {offers.isSuccess &&
        (offers.data.items.length === 0 ? (
          <EmptyState
            icon={<PackageSearchIcon />}
            title={
              filtered
                ? t('suppliers.offers.noMatch')
                : categoryId
                  ? t('suppliers.catalog.packs.empty')
                  : manual
                    ? t('suppliers.offers.emptyManual')
                    : t('suppliers.offers.empty')
            }
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {/* S18: the offer stays in view while a narrow screen scrolls the table. */}
                  <TableHead className="sticky start-0 z-10 bg-muted">
                    <span className="flex items-center gap-3">
                      {!manual && pageRows.length > 0 && (
                        <Checkbox
                          aria-label={t('suppliers.offers.selectPage')}
                          checked={pageSelected}
                          onCheckedChange={togglePage}
                        />
                      )}
                      {t('suppliers.offers.columns.name')}
                    </span>
                  </TableHead>
                  <TableHead>{t('suppliers.offers.columns.group')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.kind')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.cost')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.stock')}</TableHead>
                  {!manual && <TableHead>{t('suppliers.offers.columns.fields')}</TableHead>}
                  <TableHead>{t('suppliers.offers.columns.product')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('suppliers.offers.columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offers.data.items.map((offer) => (
                  <TableRow key={offer.id}>
                    <TableCell className="sticky start-0 z-10 min-w-56 bg-surface">
                      <span className="flex items-start gap-3">
                        {!manual &&
                          (selectable(offer) ? (
                            <Checkbox
                              aria-label={t('suppliers.offers.selectOffer', { name: offer.name })}
                              checked={selected.has(offer.id)}
                              disabled={!selected.has(offer.id) && selected.size >= MAX_IMPORT_ROWS}
                              onCheckedChange={(on) => toggle(offer, on)}
                            />
                          ) : (
                            <span className="size-4 shrink-0" aria-hidden="true" />
                          ))}
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <bdi className="font-medium">{offer.name}</bdi>
                          <bdi dir="ltr" className="text-xs text-muted-foreground">
                            {offer.offerId}
                          </bdi>
                          {offer.categoryPath.length > 0 && !categoryId && (
                            <button
                              type="button"
                              className="text-start text-xs text-muted-foreground underline-offset-4 hover:underline"
                              onClick={() => set({ categoryId: offer.categoryId ?? undefined })}
                            >
                              <bdi>{offer.categoryPath.join(' › ')}</bdi>
                            </button>
                          )}
                          {!manual && <LastSeen at={offer.lastSeenAt} />}
                          <OfferMarks offer={{ ...offer, missingSince: null }} />
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {offer.groupName ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className="text-start underline-offset-4 hover:underline"
                                onClick={() => set({ group: offer.groupName ?? undefined })}
                              />
                            }
                          >
                            <bdi>{offer.groupName}</bdi>
                          </TooltipTrigger>
                          <TooltipContent>{t('suppliers.offers.filterGroup')}</TooltipContent>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {offer.kind ? (
                        <Badge tone={offer.kind === 'code' ? 'gold' : 'info'}>
                          {t(`catalog.products.kinds.${offer.kind}`)}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t('suppliers.offers.kindUnknown')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <OfferCost offer={offer} />
                    </TableCell>
                    <TableCell>
                      {offer.missingSince ? (
                        <Badge tone="danger">
                          {t('suppliers.offers.missingSince', {
                            since: formatSince(offer.missingSince),
                          })}
                        </Badge>
                      ) : (
                        <StockChip level={offer.stockLevel} stock={offer.stock} />
                      )}
                    </TableCell>
                    {!manual && (
                      <TableCell>
                        <OfferFields offer={offer} />
                      </TableCell>
                    )}
                    <TableCell>
                      {offer.mapped ? (
                        <Link
                          to="/catalog/games/$id"
                          params={{ id: offer.mapped.gameId }}
                          search={{ tab: 'products' }}
                          className="flex flex-col gap-0.5 hover:underline"
                        >
                          <bdi className="font-medium">{offer.mapped.productNameAr}</bdi>
                          <bdi className="text-xs text-muted-foreground">
                            {offer.mapped.gameNameAr}
                          </bdi>
                        </Link>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t('suppliers.offers.unmapped')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1">
                        {linkable(offer) && (
                          <TipButton
                            label={t('suppliers.offers.link', { name: offer.name })}
                            onClick={() => setLinking(offer)}
                          >
                            <Link2Icon />
                          </TipButton>
                        )}
                        <TipButton
                          label={t('suppliers.offers.history', { name: offer.name })}
                          onClick={() => setHistory(offer)}
                        >
                          <HistoryIcon />
                        </TipButton>
                        {!manual && !offer.mapped && (
                          <IgnoreButton
                            offer={offer}
                            disabled={ignore.isPending}
                            onChange={(ignored) => setIgnored(offer, ignored)}
                          />
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={page}
              pageCount={pageCount}
              onPageChange={(next) => onSearch({ ...search, page: next > 1 ? next : undefined })}
              summary={t('suppliers.offers.total', { total: offers.data.total })}
              previousLabel={t('common.previous')}
              nextLabel={t('common.next')}
            />
          </>
        ))}
      <Dialog open={importing} onOpenChange={setImporting}>
        {importing && (
          <ImportDialog
            supplier={supplier}
            offers={[...selected.values()]}
            onImported={() => setSelected(new Map())}
          />
        )}
      </Dialog>
      <Dialog open={history !== null} onOpenChange={(open) => !open && setHistory(null)}>
        {history && <CostHistoryDialog offer={history} />}
      </Dialog>
      <Dialog open={linking !== null} onOpenChange={(open) => !open && setLinking(null)}>
        {linking && <LinkOfferDialog offer={linking} onDone={() => setLinking(null)} />}
      </Dialog>
    </div>
  );
}

/** Rule SC6: an unmapped offer ignored (no longer counted new) or counted again. */
export function IgnoreButton({
  offer,
  disabled,
  onChange,
}: {
  offer: Pick<SupplierOffer, 'name' | 'ignoredAt'>;
  disabled: boolean;
  onChange: (ignored: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = offer.ignoredAt
    ? t('suppliers.offers.unignore', { name: offer.name })
    : t('suppliers.offers.ignore', { name: offer.name });
  return (
    <TipButton label={label} disabled={disabled} onClick={() => onChange(!offer.ignoredAt)}>
      {offer.ignoredAt ? <EyeIcon /> : <EyeOffIcon />}
    </TipButton>
  );
}

/** S18: the category filter's chip by the category's name (its id until the name is read). */
function CategoryChip({
  supplier,
  categoryId,
  onClear,
}: {
  supplier: SupplierDetail;
  categoryId: string;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const category = useQuery(categoryQuery(supplier.code, categoryId));
  const name = category.data ? [...category.data.path, category.data.name].join(' › ') : categoryId;
  return (
    <Badge tone="outline" className="h-8 gap-2 ps-3 pe-1">
      {t('suppliers.offers.categoryFilter')} <bdi>{name}</bdi>
      {/* Audit A05-48: an icon button with its tooltip. */}
      <TipButton label={t('suppliers.offers.clearCategory')} onClick={onClear}>
        <XIcon />
      </TipButton>
    </Badge>
  );
}

function Filters({
  supplier,
  search,
  manual,
  categoryLocked,
  onSearch,
  onClear,
}: {
  supplier: SupplierDetail;
  search: OfferSearch;
  manual: boolean;
  categoryLocked: boolean;
  onSearch: (next: OfferSearch) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState(search.q ?? '');
  // The box follows the URL on back and forward (audit A05-51).
  useEffect(() => setQ(search.q ?? ''), [search.q]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = q.trim();
    onSearch({ q: value.length >= 1 && value.length <= 100 ? value : undefined });
  }

  const flag = (name: FlagName) => {
    const items = [
      { value: ALL, label: t('suppliers.offers.filters.all') },
      { value: 'true', label: t(`suppliers.offers.filters.${name}.true`) },
      { value: 'false', label: t(`suppliers.offers.filters.${name}.false`) },
    ];
    return (
      <Field className="w-full sm:w-44">
        <FieldLabel>{t(`suppliers.offers.filters.${name}.label`)}</FieldLabel>
        <Select
          items={items}
          value={search[name] ?? ALL}
          onValueChange={(next) =>
            onSearch({ [name]: next === 'true' || next === 'false' ? next : undefined })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  };

  const shown = Object.keys(search).some(
    (name) => name !== 'page' && !(categoryLocked && name === 'categoryId'),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <form className="flex items-end gap-2" onSubmit={submit}>
          <Field className="w-64">
            <FieldLabel>{t('suppliers.offers.search')}</FieldLabel>
            <Input
              name="q"
              value={q}
              placeholder={t('suppliers.offers.searchPlaceholder')}
              onChange={(event) => setQ(event.target.value)}
            />
          </Field>
          <TipButton
            type="submit"
            variant="outline"
            size="icon"
            label={t('suppliers.offers.searchSubmit')}
          >
            <SearchIcon />
          </TipButton>
        </form>
        {!manual && flag('mapped')}
        {flag('inStock')}
        {!manual && flag('missing')}
        {!manual && flag('supported')}
        {!manual && flag('ignored')}
        {!manual && flag('lowStock')}
        {!manual && flag('discounted')}
      </div>
      {shown && (
        <div className="flex flex-wrap items-center gap-2">
          {search.categoryId && !categoryLocked && (
            <CategoryChip
              supplier={supplier}
              categoryId={search.categoryId}
              onClear={() => onSearch({ categoryId: undefined })}
            />
          )}
          {search.group && (
            <Badge tone="outline" className="h-8 gap-2 ps-3 pe-1">
              {t('suppliers.offers.groupFilter')} <bdi>{search.group}</bdi>
              <TipButton
                label={t('suppliers.offers.clearGroup')}
                onClick={() => onSearch({ group: undefined })}
              >
                <XIcon />
              </TipButton>
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              onClear();
            }}
          >
            {t('suppliers.offers.clearFilters')}
          </Button>
        </div>
      )}
    </div>
  );
}
