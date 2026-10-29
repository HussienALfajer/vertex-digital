import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type Currency,
  formatUsd,
  type LedgerSummary,
  type WalletHighlight,
  type WalletSearchResult,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { CircleAlertIcon, SearchIcon, SearchXIcon } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { money } from '../reconciliation/reconciliation-labels';
import {
  GROSS_PROFIT_KEYS,
  type LedgerGroupView,
  type LedgerRow,
  ledgerOverview,
  supplierNameOf,
} from './ledger-groups';
import { ledgerSummaryQuery, walletHighlightsQuery, walletSearchQuery } from './wallet.queries';

/** The shortest search the API accepts (`walletSearchQuerySchema`). */
const MIN_SEARCH = 3;

/**
 * Wallets (S02): the books from the owner's side (what the store holds, owes and earned, and the
 * owner's money, rule L1), and a search by name, email or phone whose rows open the wallet, with
 * the largest and the latest wallets below it until something is searched. The search lives in
 * the URL (`?q=`).
 */
export function WalletsPage({ q, onSearch }: { q?: string; onSearch: (q?: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('wallets.title')} description={t('wallets.subtitle')} />
      <SummaryCard />
      {/* A new key resets the field when the URL changes (back, forward). */}
      <SearchForm key={q ?? ''} q={q} onSearch={onSearch} />
      {q ? <SearchResults q={q} /> : <Highlights />}
    </>
  );
}

function SummaryCard() {
  const { t } = useTranslation();
  const summary = useQuery(ledgerSummaryQuery);
  return (
    <Card>
      <h2 className="text-lg font-bold">{t('wallets.summary.title')}</h2>
      {summary.isPending && (
        <div className="grid gap-4 lg:grid-cols-2" aria-hidden="true">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-32 w-full" />
          ))}
        </div>
      )}
      {summary.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, summary.error)}</FormAlert>
          <Button variant="outline" onClick={() => summary.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {summary.isSuccess && <Summary summary={summary.data} />}
    </Card>
  );
}

/** The balance check, then each group; the conversion pair and the test money only when held. */
function Summary({ summary }: { summary: LedgerSummary }) {
  const { t } = useTranslation();
  const overview = ledgerOverview(summary);
  const balanced = overview.imbalances.length === 0;
  return (
    <>
      <Badge tone={balanced ? 'success' : 'danger'}>
        {balanced ? t('wallets.summary.balanced') : t('wallets.summary.unbalanced')}
      </Badge>
      {!balanced && (
        <Callout
          tone="danger"
          icon={<CircleAlertIcon />}
          title={t('wallets.summary.unbalancedTitle')}
          description={t('wallets.summary.unbalancedBody', {
            amounts: overview.imbalances
              .map((total) => money(t, total.currency, total.units))
              .join('، '),
          })}
        />
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {overview.groups
          .filter(
            (view) =>
              (view.group !== 'exchange' && view.group !== 'test') ||
              view.rows.some((row) => row.units !== 0),
          )
          .map((view) => (
            <GroupSection
              key={view.group}
              view={view}
              grossProfitUnits={overview.grossProfitUnits}
              walletsWithBalance={summary.walletsWithBalance}
            />
          ))}
      </div>
    </>
  );
}

/** One group: its rows, the gross profit after the sales lines (result), and its totals. */
function GroupSection({
  view,
  grossProfitUnits,
  walletsWithBalance,
}: {
  view: LedgerGroupView;
  grossProfitUnits: number | null;
  walletsWithBalance: number;
}) {
  const { t } = useTranslation();
  const headingId = `ledger-${view.group}`;
  const lastGross = view.rows.findLastIndex((row) => GROSS_PROFIT_KEYS.includes(row.key));
  const totalLabel =
    view.group === 'result'
      ? t('wallets.ledger.net')
      : view.group === 'capital'
        ? t('wallets.ledger.capitalNet')
        : t('wallets.summary.total');
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div>
        <h3 id={headingId} className="text-base font-bold">
          {t(`wallets.ledger.groups.${view.group}`)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(`wallets.ledger.groupHints.${view.group}`)}
        </p>
      </div>
      {view.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('wallets.summary.empty')}</p>
      ) : (
        <Table>
          <TableBody>
            {view.rows.map((row, index) => (
              <Fragment key={row.code ?? row.key}>
                <TableRow>
                  <TableCell>
                    <RowName row={row} />
                  </TableCell>
                  <TableCell className="text-end whitespace-nowrap tabular-nums">
                    <RowAmount row={row} />
                  </TableCell>
                </TableRow>
                {view.group === 'result' && index === lastGross && grossProfitUnits !== null && (
                  <TableRow>
                    <TableCell className="font-medium">{t('wallets.ledger.grossProfit')}</TableCell>
                    <TableCell className="text-end whitespace-nowrap tabular-nums">
                      <Outcome units={grossProfitUnits} currency="USD" />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {view.totals.map((total) => (
              <TableRow key={total.currency} className="font-bold">
                <TableCell>{totalLabel}</TableCell>
                <TableCell className="text-end whitespace-nowrap tabular-nums">
                  {view.group === 'result' ? (
                    <Outcome units={total.units} currency={total.currency} />
                  ) : (
                    money(t, total.currency, total.units)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.group === 'liabilities' && (
        <p className="text-sm text-muted-foreground">
          {t('wallets.summary.withBalance', { count: walletsWithBalance })}
        </p>
      )}
    </section>
  );
}

/** A row's name, opening what the figure means, when it changes, and the account's code. */
function RowName({ row }: { row: LedgerRow }) {
  const { t } = useTranslation();
  const supplier = row.params.supplier;
  const known = supplier === undefined ? null : supplierNameOf(supplier);
  const name = t(`wallets.ledger.accounts.${row.key}`, {
    supplier: known ? t(`suppliers.names.${known}`) : supplier,
    network: row.params.network,
  });
  return (
    <Popover>
      <PopoverTrigger
        className="rounded-sm text-start underline decoration-dotted underline-offset-4"
        aria-label={t('wallets.summary.about', { name })}
      >
        {name}
      </PopoverTrigger>
      <PopoverContent className="w-72 gap-2 p-4">
        <PopoverTitle>{name}</PopoverTitle>
        <p className="text-sm">{t(`wallets.ledger.hints.${row.key}`)}</p>
        {row.code && (
          <p className="text-xs text-muted-foreground">
            {t('wallets.summary.code')}: <code dir="ltr">{row.code}</code>
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Result and capital rows say whether they add or take; the others are shown as they are. */
function RowAmount({ row }: { row: LedgerRow }) {
  const { t } = useTranslation();
  const amount = money(t, row.currency, row.units);
  if (row.effect === null) return amount;
  return (
    <>
      <span className="sr-only">{t(`wallets.summary.${row.effect}`)} </span>
      <span aria-hidden="true" className="text-muted-foreground">
        {row.effect === 'add' ? '+' : '−'}{' '}
      </span>
      {amount}
    </>
  );
}

/** A profit or a loss: its size and its word, never a bare minus sign. */
function Outcome({ units, currency }: { units: number; currency: Currency }) {
  const { t } = useTranslation();
  const [tone, word] =
    units > 0
      ? (['success', t('wallets.ledger.profit')] as const)
      : units < 0
        ? (['danger', t('wallets.ledger.loss')] as const)
        : (['neutral', t('wallets.ledger.even')] as const);
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={tone}>{word}</Badge>
      {money(t, currency, Math.abs(units))}
    </span>
  );
}

function SearchForm({ q, onSearch }: { q?: string; onSearch: (q?: string) => void }) {
  const { t } = useTranslation();
  const [tooShort, setTooShort] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    const short = value.length > 0 && value.length < MIN_SEARCH;
    setTooShort(short);
    if (short) return focusInvalid();
    onSearch(value || undefined);
  }

  return (
    <search>
      <form ref={ref} className="flex items-start gap-2" onSubmit={submit} noValidate>
        <Field invalid={tooShort} className="flex-1">
          <FieldLabel className="sr-only">{t('wallets.search.label')}</FieldLabel>
          <Input
            name="q"
            type="search"
            defaultValue={q}
            placeholder={t('wallets.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
          />
          <FieldError match={tooShort}>{t('wallets.search.tooShort')}</FieldError>
        </Field>
        <Button type="submit">
          <SearchIcon />
          {t('wallets.search.submit')}
        </Button>
      </form>
    </search>
  );
}

function SearchResults({ q }: { q: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(walletSearchQuery(q));
  const results = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      {list.isPending && <RowsSkeleton />}
      {list.isError && <Retry error={list.error} onRetry={() => list.refetch()} />}
      {list.isSuccess && results.length === 0 && (
        <EmptyState
          icon={<SearchXIcon />}
          title={t('wallets.search.emptyTitle')}
          description={t('wallets.search.emptyBody')}
        />
      )}
      {results.length > 0 && <WalletTable wallets={results} />}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}
    </>
  );
}

/** Below the search until something is searched: the largest balances and the last to move. */
function Highlights() {
  const { t } = useTranslation();
  const lists = useQuery(walletHighlightsQuery);
  if (lists.isPending) return <RowsSkeleton />;
  if (lists.isError) return <Retry error={lists.error} onRetry={() => lists.refetch()} />;
  const { withBalance, recentlyMoved } = lists.data;
  if (withBalance.length === 0 && recentlyMoved.length === 0) {
    return (
      <EmptyState
        icon={<SearchIcon />}
        title={t('wallets.search.promptTitle')}
        description={t('wallets.search.promptBody')}
      />
    );
  }
  return (
    <>
      <HighlightList
        id="wallets-with-balance"
        title={t('wallets.search.withBalance')}
        wallets={withBalance}
      />
      <HighlightList
        id="wallets-recently-moved"
        title={t('wallets.search.recentlyMoved')}
        wallets={recentlyMoved}
      />
    </>
  );
}

function HighlightList({
  id,
  title,
  wallets,
}: {
  id: string;
  title: string;
  wallets: WalletHighlight[];
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-lg font-bold">
        {title}
      </h2>
      {wallets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('wallets.search.listEmpty')}</p>
      ) : (
        <WalletTable wallets={wallets} />
      )}
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-11 w-full" />
      ))}
    </div>
  );
}

function Retry({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3">
      <FormAlert>{errorMessage(t, error)}</FormAlert>
      <Button variant="outline" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

/** Wallet rows that open the wallet; the highlights add when each one last moved. */
function WalletTable({ wallets }: { wallets: (WalletSearchResult | WalletHighlight)[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const open = (customerId: string) =>
    navigate({ to: '/wallets/$customerId', params: { customerId } });
  const withMoves = wallets.some((wallet) => 'lastMovedAt' in wallet);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('wallets.columns.name')}</TableHead>
          <TableHead>{t('wallets.columns.email')}</TableHead>
          <TableHead>{t('wallets.columns.phone')}</TableHead>
          <TableHead>{t('wallets.columns.balance')}</TableHead>
          {withMoves && <TableHead>{t('wallets.columns.lastMoved')}</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {wallets.map((customer) => (
          <TableRow key={customer.id} className="cursor-pointer" onClick={() => open(customer.id)}>
            <TableCell>
              <span className="flex items-center gap-2">
                {/* The keyboard way into the wallet; the whole row also opens it. */}
                <button
                  type="button"
                  className="rounded-sm text-start font-medium text-foreground hover:underline"
                  aria-label={t('wallets.search.open', { name: customer.name })}
                  onClick={(event) => {
                    event.stopPropagation();
                    open(customer.id);
                  }}
                >
                  {customer.name}
                </button>
                {customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
              </span>
            </TableCell>
            <TableCell dir="ltr" className="text-end">
              {customer.email}
            </TableCell>
            <TableCell dir="ltr" className="text-end whitespace-nowrap">
              {customer.phone}
            </TableCell>
            <TableCell className="font-medium tabular-nums">
              <bdi dir="ltr">{formatUsd(customer.balanceUnits)}</bdi>
            </TableCell>
            {withMoves && (
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {'lastMovedAt' in customer && customer.lastMovedAt
                  ? formatDateTime(customer.lastMovedAt)
                  : null}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
