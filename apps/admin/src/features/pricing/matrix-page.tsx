import { useQueries, useQuery } from '@tanstack/react-query';
import {
  formatUsd,
  PRICE_MATRIX_MAX_LISTS,
  type PriceMatrixCell,
  ROOT_PRICE_LIST_IDS,
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
  PageHeader,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { Grid3x3Icon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { allGamesQuery } from '../catalog/catalog.queries';
import { FixedPriceDialog, SourceBadge } from './fixed-price-dialog';
import type { MatrixSearch } from './matrix-search';
import { Picker } from './picker';
import { listRulesQuery, priceListsQuery, priceMatrixQuery } from './pricing.queries';
import { formatPercentBp } from './pricing-format';

const WARNING_TONES = {
  fallback: 'warning',
  capped: 'gold',
  above_parent: 'danger',
  held: 'info',
  unavailable: 'danger',
  no_row: 'neutral',
} as const;

/**
 * "مصفوفة الأسعار" (S20 screens): a game's packs (or a search) by the chosen lists, retail first;
 * each cell its price, margin, source and warnings, a held pack's target in a muted line. A cell
 * opens that list's fixed price for the pack.
 */
export function MatrixPage({
  search,
  onSearch,
}: {
  search: MatrixSearch;
  onSearch: (next: MatrixSearch) => void;
}) {
  const { t } = useTranslation();
  const games = useQuery(allGamesQuery);
  const lists = useQuery(priceListsQuery);
  const matrix = useQuery(priceMatrixQuery(search));
  const [q, setQ] = useState(search.q ?? '');
  const [opened, setOpened] = useState<{ listId: string; row: MatrixRow } | null>(null);
  const warningsId = useId();
  useEffect(() => setQ(search.q ?? ''), [search.q]);

  const live = (lists.data ?? []).filter(
    (list) => list.archivedAt === null && list.id !== ROOT_PRICE_LIST_IDS.retail,
  );
  const chosen = search.lists ?? [ROOT_PRICE_LIST_IDS.wholesale, ROOT_PRICE_LIST_IDS.cost];
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
    onSearch({ ...search, lists: next.slice(0, PRICE_MATRIX_MAX_LISTS - 1) });
  };

  return (
    <>
      <PageHeader title={t('pricing.matrix.title')} description={t('pricing.matrix.subtitle')} />
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel render={<span />}>{t('pricing.scopes.game')}</FieldLabel>
            <Picker
              label={t('pricing.scopes.game')}
              placeholder={t('pricing.calculator.choose')}
              items={(games.data?.items ?? []).map((item) => ({
                value: item.id,
                label: item.nameAr,
              }))}
              value={search.gameId ?? null}
              onChange={(gameId) => onSearch({ ...search, gameId, q: undefined })}
            />
          </Field>
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
              <Input name="q" value={q} onChange={(event) => setQ(event.target.value)} />
            </Field>
          </form>
        </div>
        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="mb-2 text-sm font-medium">{t('pricing.matrix.lists')}</legend>
          {live.map((list) => (
            <label
              key={list.id}
              htmlFor={`${warningsId}-${list.id}`}
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id={`${warningsId}-${list.id}`}
                checked={chosen.includes(list.id)}
                disabled={!chosen.includes(list.id) && chosen.length >= PRICE_MATRIX_MAX_LISTS - 1}
                onCheckedChange={() => toggle(list.id)}
              />
              {list.name}
            </label>
          ))}
          <label htmlFor={warningsId} className="ms-auto flex items-center gap-2 text-sm">
            <Switch
              id={warningsId}
              checked={!!search.warnings}
              onCheckedChange={(on) => onSearch({ ...search, warnings: on ? true : undefined })}
            />
            {t('pricing.matrix.warningsOnly')}
          </label>
        </fieldset>
        {!search.gameId && !search.q ? (
          <EmptyState
            icon={<Grid3x3Icon />}
            title={t('pricing.matrix.choose')}
            description={t('pricing.matrix.chooseHint')}
          />
        ) : matrix.isPending ? (
          <Skeleton className="h-64 w-full" aria-hidden="true" />
        ) : matrix.isError ? (
          <div className="flex flex-col items-start gap-3">
            <FormAlert>{errorMessage(t, matrix.error)}</FormAlert>
            <Button variant="outline" onClick={() => matrix.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : matrix.data.rows.length === 0 ? (
          <EmptyState icon={<Grid3x3Icon />} title={t('pricing.matrix.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pricing.columns.product')}</TableHead>
                <TableHead>{t('pricing.matrix.cost')}</TableHead>
                {matrix.data.lists.map((list) => (
                  <TableHead key={list.id}>{list.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {matrix.data.rows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="whitespace-normal">
                    <span className="font-medium">{row.productNameAr}</span>
                    <span className="block text-xs text-muted-foreground">{row.gameNameAr}</span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.costUsdUnits === null ? '—' : ltr(formatUsd(row.costUsdUnits))}
                  </TableCell>
                  {row.cells.map((cell) => (
                    <TableCell key={cell.priceListId} className="align-top">
                      <button
                        type="button"
                        className="flex w-full flex-col items-start gap-1 rounded-md p-1 text-start hover:bg-muted"
                        aria-label={t('pricing.matrix.openCell', {
                          list: matrix.data.lists.find((list) => list.id === cell.priceListId)
                            ?.name,
                          product: row.productNameAr,
                        })}
                        onClick={() => setOpened({ listId: cell.priceListId, row })}
                      >
                        <MatrixCell cell={cell} />
                      </button>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
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

type MatrixRow = {
  productId: string;
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
  const reads = useQueries({ queries: chain.map((id) => listRulesQuery(id)) });
  const cell = row.cells.find((candidate) => candidate.priceListId === listId);
  if (reads.some((read) => !read.isSuccess)) {
    return <Skeleton className="h-64 w-full" aria-hidden="true" />;
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
