import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { formatUsd, type LedgerSummary } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { SearchIcon, SearchXIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { ledgerSummaryQuery, walletSearchQuery } from './wallet.queries';

/** The shortest search the API accepts (`walletSearchQuerySchema`). */
const MIN_SEARCH = 3;

/**
 * Wallets (S02): what the store owes its customers (rule L1), and a search by name, email or
 * phone whose rows open the wallet. The search lives in the URL (`?q=`).
 */
export function WalletsPage({ q, onSearch }: { q?: string; onSearch: (q?: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('wallets.title')} description={t('wallets.subtitle')} />
      <SummaryCard />
      {/* A new key resets the field when the URL changes (back, forward). */}
      <SearchForm key={q ?? ''} q={q} onSearch={onSearch} />
      {q ? (
        <SearchResults q={q} />
      ) : (
        <EmptyState
          icon={<SearchIcon />}
          title={t('wallets.search.promptTitle')}
          description={t('wallets.search.promptBody')}
        />
      )}
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
        <div className="grid gap-4 sm:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-16 w-full" />
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

function Summary({ summary }: { summary: LedgerSummary }) {
  const { t } = useTranslation();
  return (
    <>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Stat label={t('wallets.summary.owed')} value={formatUsd(summary.owedToCustomersUnits)} />
        <Stat
          label={t('wallets.summary.owedTest')}
          value={formatUsd(summary.owedToTestCustomersUnits)}
        />
        <Stat label={t('wallets.summary.withBalance')} value={String(summary.walletsWithBalance)} />
      </dl>
      <Collapsible>
        <CollapsibleTrigger>{t('wallets.summary.systemAccounts')}</CollapsibleTrigger>
        <CollapsiblePanel>
          {summary.systemAccounts.length === 0 ? (
            <p className="pt-2 text-sm text-muted-foreground">
              {t('wallets.summary.noSystemAccounts')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('wallets.summary.kind')}</TableHead>
                  <TableHead>{t('wallets.summary.code')}</TableHead>
                  <TableHead>{t('wallets.summary.balance')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.systemAccounts.map((account) => (
                  <TableRow key={account.code}>
                    <TableCell>{t(`wallets.accountKinds.${account.kind}`)}</TableCell>
                    <TableCell>
                      <code dir="ltr" className="text-sm">
                        {account.code}
                      </code>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <bdi dir="ltr">{formatUsd(account.balanceUnits)}</bdi>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CollapsiblePanel>
      </Collapsible>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-bold tabular-nums">
        <bdi dir="ltr">{value}</bdi>
      </dd>
    </div>
  );
}

function SearchForm({ q, onSearch }: { q?: string; onSearch: (q?: string) => void }) {
  const { t } = useTranslation();
  const [tooShort, setTooShort] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    const short = value.length > 0 && value.length < MIN_SEARCH;
    setTooShort(short);
    if (!short) onSearch(value || undefined);
  }

  return (
    <search>
      <form className="flex items-start gap-2" onSubmit={submit} noValidate>
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
  const navigate = useNavigate();
  const list = useInfiniteQuery(walletSearchQuery(q));
  const results = list.data?.pages.flatMap((page) => page.items) ?? [];
  const open = (customerId: string) =>
    navigate({ to: '/wallets/$customerId', params: { customerId } });

  return (
    <>
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-11 w-full" />
          ))}
        </div>
      )}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess && results.length === 0 && (
        <EmptyState
          icon={<SearchXIcon />}
          title={t('wallets.search.emptyTitle')}
          description={t('wallets.search.emptyBody')}
        />
      )}
      {results.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('wallets.columns.name')}</TableHead>
              <TableHead>{t('wallets.columns.email')}</TableHead>
              <TableHead>{t('wallets.columns.phone')}</TableHead>
              <TableHead>{t('wallets.columns.balance')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((customer) => (
              <TableRow
                key={customer.id}
                className="cursor-pointer"
                onClick={() => open(customer.id)}
              >
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
