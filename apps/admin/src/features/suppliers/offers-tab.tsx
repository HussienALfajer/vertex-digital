import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  formatUsd,
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
import { HistoryIcon, PackageSearchIcon, SearchIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { CostHistoryDialog } from './cost-history-dialog';
import { ImportDialog } from './import-dialog';
import type { OfferSearch } from './supplier-search';
import { LIST_PAGE_SIZE, offersQuery } from './suppliers.queries';

type FlagName = 'mapped' | 'inStock' | 'missing';

const ALL = 'all';

/**
 * "العروض" (S07 screens): the supplier's offers with their cost and its freshness, stock and
 * mapping; filters and search in the URL; offers selected across pages and imported into a game
 * (rule RT8); an offer's cost history. `manual` lists the manual offers with their products.
 */
export function OffersTab({
  supplier,
  search,
  onSearch,
}: {
  supplier: SupplierDetail;
  search: OfferSearch;
  onSearch: (next: OfferSearch) => void;
}) {
  const { t } = useTranslation();
  const offers = useQuery(offersQuery(supplier.code, search));
  const [selected, setSelected] = useState<Map<string, SupplierOffer>>(new Map());
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<SupplierOffer | null>(null);
  const manual = supplier.code === 'manual';
  const filtered = Object.keys(search).some((name) => name !== 'page');
  const page = search.page ?? 1;
  const pageCount = Math.max(1, Math.ceil((offers.data?.total ?? 0) / LIST_PAGE_SIZE));

  const set = (next: OfferSearch) => onSearch({ ...search, ...next, page: undefined });
  const selectable = (offer: SupplierOffer) => !manual && !offer.mapped && !offer.missingSince;
  const toggle = (offer: SupplierOffer, on: boolean) =>
    setSelected((previous) => {
      const next = new Map(previous);
      if (on && next.size < MAX_IMPORT_ROWS) next.set(offer.id, offer);
      else next.delete(offer.id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <Filters search={search} manual={manual} onSearch={set} onClear={() => onSearch({})} />
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
                  {!manual && (
                    <TableHead>
                      <span className="sr-only">{t('suppliers.offers.columns.select')}</span>
                    </TableHead>
                  )}
                  <TableHead>{t('suppliers.offers.columns.name')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.group')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.kind')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.cost')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.stock')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.product')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('suppliers.offers.columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offers.data.items.map((offer) => (
                  <TableRow key={offer.id}>
                    {!manual && (
                      <TableCell>
                        {selectable(offer) && (
                          <Checkbox
                            aria-label={t('suppliers.offers.selectOffer', { name: offer.name })}
                            checked={selected.has(offer.id)}
                            disabled={!selected.has(offer.id) && selected.size >= MAX_IMPORT_ROWS}
                            onCheckedChange={(on) => toggle(offer, on)}
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <span className="flex flex-col gap-0.5">
                        <bdi className="font-medium">{offer.name}</bdi>
                        <bdi dir="ltr" className="text-xs text-muted-foreground">
                          {offer.offerId}
                        </bdi>
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
                      ) : offer.inStock ? (
                        <Badge tone="success">{t('suppliers.offers.inStock')}</Badge>
                      ) : (
                        <Badge tone="warning">{t('suppliers.offers.outOfStock')}</Badge>
                      )}
                    </TableCell>
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
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('suppliers.offers.history', { name: offer.name })}
                              onClick={() => setHistory(offer)}
                            />
                          }
                        >
                          <HistoryIcon />
                        </TooltipTrigger>
                        <TooltipContent>
                          {t('suppliers.offers.history', { name: offer.name })}
                        </TooltipContent>
                      </Tooltip>
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
    </div>
  );
}

/** The cost and its freshness (rule SY5), or the raw value when it is not a usable USD cost. */
function OfferCost({ offer }: { offer: SupplierOffer }) {
  const { t } = useTranslation();
  if (offer.costUsdUnits === null) {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge tone="warning">{t('suppliers.offers.costUnknown')}</Badge>
        {offer.costRaw && (
          <bdi dir="ltr" className="text-xs text-muted-foreground">
            {offer.costRaw}
          </bdi>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5">
      <bdi dir="ltr" className="font-medium tabular-nums">
        {formatUsd(offer.costUsdUnits)}
      </bdi>
      {offer.costStale ? (
        <Badge tone="warning">{t('suppliers.offers.costStale')}</Badge>
      ) : (
        offer.costConfirmedAt && (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(offer.costConfirmedAt)}
          >
            {formatSince(offer.costConfirmedAt)}
          </span>
        )
      )}
    </span>
  );
}

function Filters({
  search,
  manual,
  onSearch,
  onClear,
}: {
  search: OfferSearch;
  manual: boolean;
  onSearch: (next: OfferSearch) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState(search.q ?? '');

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
          <Button type="submit" variant="outline" aria-label={t('suppliers.offers.searchSubmit')}>
            <SearchIcon />
          </Button>
        </form>
        {!manual && flag('mapped')}
        {flag('inStock')}
        {!manual && flag('missing')}
      </div>
      {Object.keys(search).some((name) => name !== 'page') && (
        <div className="flex flex-wrap items-center gap-2">
          {search.group && (
            <Badge tone="outline" className="h-8 gap-2 ps-3 pe-1">
              {t('suppliers.offers.groupFilter')} <bdi>{search.group}</bdi>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={t('suppliers.offers.clearGroup')}
                onClick={() => onSearch({ group: undefined })}
              >
                <XIcon />
              </Button>
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
