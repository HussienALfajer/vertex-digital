import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminWallet,
  type AdminWalletEntry,
  formatRate,
  formatSignedUsd,
  formatSyp,
  formatUsd,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ArrowRightIcon, RotateCcwIcon, SlidersHorizontalIcon, WalletIcon } from 'lucide-react';
import { type MouseEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { AdjustDialog } from './adjust-dialog';
import { ReverseDialog } from './reverse-dialog';
import { walletEntriesQuery, walletQuery } from './wallet.queries';
import { adjustmentRowId, entryLabel } from './wallet-labels';

/**
 * One customer's wallet (S02): who it belongs to, the balance, the timeline with the internal
 * reason and the admin of each adjustment, and the adjust and reverse actions (rules J1–J10,
 * R1–R5).
 */
export function WalletPage({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const wallet = useQuery(walletQuery(customerId));
  const [adjusting, setAdjusting] = useState(false);
  const [reversing, setReversing] = useState<AdminWalletEntry | null>(null);

  const back = (
    <Button variant="ghost" className="self-start" render={<Link to="/wallets" />}>
      <ArrowRightIcon className="ltr:-scale-x-100" />
      {t('wallets.detail.back')}
    </Button>
  );

  if (wallet.isPending) {
    return (
      <>
        {back}
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }
  if (wallet.isError) {
    return (
      <>
        {back}
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, wallet.error)}</FormAlert>
          <Button variant="outline" onClick={() => wallet.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      </>
    );
  }

  const { customer } = wallet.data;
  return (
    <>
      {back}
      <PageHeader
        title={customer.name}
        actions={
          <Button onClick={() => setAdjusting(true)}>
            <SlidersHorizontalIcon />
            {t('wallets.detail.adjust')}
          </Button>
        }
      />
      <WalletHeader wallet={wallet.data} />
      <Timeline customerId={customerId} onReverse={setReversing} />

      <Dialog open={adjusting} onOpenChange={setAdjusting}>
        {adjusting && <AdjustDialog wallet={wallet.data} onDone={() => setAdjusting(false)} />}
      </Dialog>
      <Dialog open={!!reversing} onOpenChange={(open) => !open && setReversing(null)}>
        {reversing?.adjustment && (
          <ReverseDialog
            entry={reversing}
            adjustment={reversing.adjustment}
            balanceUnits={wallet.data.balanceUnits}
            onDone={() => setReversing(null)}
          />
        )}
      </Dialog>
    </>
  );
}

function WalletHeader({ wallet }: { wallet: AdminWallet }) {
  const { t } = useTranslation();
  const { customer } = wallet;
  return (
    <Card className="flex-row flex-wrap items-end justify-between gap-6">
      <dl className="flex flex-col gap-1 text-base">
        <div className="flex items-center gap-2">
          <dt className="sr-only">{t('wallets.columns.email')}</dt>
          <dd dir="ltr">{customer.email}</dd>
          {customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
        </div>
        <div>
          <dt className="sr-only">{t('wallets.columns.phone')}</dt>
          <dd dir="ltr" className="text-end text-muted-foreground">
            {customer.phone}
          </dd>
        </div>
      </dl>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{t('wallets.detail.balance')}</p>
        <p className="text-3xl font-bold tabular-nums">
          <bdi dir="ltr">{formatUsd(wallet.balanceUnits)}</bdi>
        </p>
        {wallet.syp && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {t('wallets.detail.syp', {
              amount: formatSyp(wallet.syp.valueUnits),
              rate: formatRate(wallet.syp.rate),
            })}
          </p>
        )}
      </div>
    </Card>
  );
}

function Timeline({
  customerId,
  onReverse,
}: {
  customerId: string;
  onReverse: (entry: AdminWalletEntry) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(walletEntriesQuery(customerId));
  const entries = list.data?.pages.flatMap((page) => page.items) ?? [];
  const [shown, setShown] = useState<string | null>(null);

  // The row a link asked for, once it is on the page: its anchor scrolls to it and marks it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page of entries is the trigger.
  useEffect(() => {
    if (!shown || !document.getElementById(adjustmentRowId(shown))) return;
    setShown(null);
    window.location.hash = adjustmentRowId(shown);
  }, [shown, entries.length]);

  /**
   * Shows a linked adjustment: an original can sit on a page not loaded yet (a reversal is newer
   * than its original), so pages are read until it is there (audit A8).
   */
  async function showAdjustment(id: string) {
    setShown(id);
    let pages = list.data?.pages ?? [];
    let more = list.hasNextPage;
    const holds = () =>
      pages.some((page) => page.items.some((entry) => entry.adjustment?.id === id));
    while (!holds() && more) {
      const next = await list.fetchNextPage();
      if (next.isError) return;
      pages = next.data?.pages ?? [];
      more = next.hasNextPage;
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="wallet-timeline">
      <h2 id="wallet-timeline" className="text-lg font-bold">
        {t('wallets.detail.timeline')}
      </h2>
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
      {list.isSuccess && entries.length === 0 && (
        <EmptyState
          icon={<WalletIcon />}
          title={t('wallets.detail.emptyTitle')}
          description={t('wallets.detail.emptyBody')}
        />
      )}
      {entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('wallets.detail.columns.time')}</TableHead>
              <TableHead>{t('wallets.detail.columns.entry')}</TableHead>
              <TableHead>{t('wallets.detail.columns.amount')}</TableHead>
              <TableHead>{t('wallets.detail.columns.balanceAfter')}</TableHead>
              <TableHead>{t('wallets.detail.columns.reason')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('wallets.detail.columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <EntryRow
                key={entry.journalId}
                entry={entry}
                onReverse={onReverse}
                onShowAdjustment={showAdjustment}
              />
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
    </section>
  );
}

function EntryRow({
  entry,
  onReverse,
  onShowAdjustment,
}: {
  entry: AdminWalletEntry;
  onReverse: (entry: AdminWalletEntry) => void;
  onShowAdjustment: (id: string) => void;
}) {
  const { t } = useTranslation();
  const adjustment = entry.adjustment;
  /** Follows the anchor when its row is on the page, else loads pages until it is. */
  const linkTo = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (document.getElementById(adjustmentRowId(id))) return;
    event.preventDefault();
    onShowAdjustment(id);
  };
  const reversible = adjustment && !adjustment.reversal && !adjustment.reversedByAdjustmentId;
  return (
    <TableRow
      id={adjustment ? adjustmentRowId(adjustment.id) : undefined}
      className="scroll-mt-20 target:bg-muted"
    >
      <TableCell className="whitespace-nowrap">{formatDateTime(entry.occurredAt)}</TableCell>
      <TableCell className="min-w-44 whitespace-normal">
        <span className="flex flex-col gap-1">
          <span className="font-medium">{entryLabel(t, entry)}</span>
          {adjustment?.customerNote && (
            <span className="text-muted-foreground">{adjustment.customerNote}</span>
          )}
          {entry.deposit && (
            <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <Link
                to="/deposits/$id"
                params={{ id: entry.deposit.id }}
                className="rounded-sm underline underline-offset-4"
              >
                <bdi dir="ltr">{entry.deposit.referenceCode}</bdi>
              </Link>
              {entry.deposit.syp && (
                <span className="tabular-nums">
                  {t('wallets.detail.depositSyp', {
                    amount: formatSyp(entry.deposit.syp.amountUnits),
                    rate: formatRate(entry.deposit.syp.rate),
                  })}
                </span>
              )}
            </span>
          )}
          {adjustment?.depositMethod && adjustment.externalReference && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              {t(`wallets.methods.${adjustment.depositMethod}`)}
              {/* A TXID is 64 characters: shortened here, whole on hover and in the audit log. */}
              <code dir="ltr" title={adjustment.externalReference} className="max-w-36 truncate">
                {adjustment.externalReference}
              </code>
            </span>
          )}
          {adjustment?.reversedByAdjustmentId && (
            <a
              href={`#${adjustmentRowId(adjustment.reversedByAdjustmentId)}`}
              onClick={linkTo(adjustment.reversedByAdjustmentId)}
              className="w-fit rounded-sm"
              aria-label={`${t('wallets.detail.reversed')}: ${t('wallets.detail.showRow')}`}
            >
              <Badge tone="neutral">{t('wallets.detail.reversed')}</Badge>
            </a>
          )}
          {adjustment?.reversesAdjustmentId && (
            <a
              href={`#${adjustmentRowId(adjustment.reversesAdjustmentId)}`}
              onClick={linkTo(adjustment.reversesAdjustmentId)}
              className="w-fit rounded-sm text-sm text-muted-foreground underline"
            >
              {t('wallets.detail.reversalOf')}
            </a>
          )}
        </span>
      </TableCell>
      <TableCell
        className={
          entry.amountUnits > 0
            ? 'font-medium whitespace-nowrap text-status-success-foreground tabular-nums'
            : 'font-medium whitespace-nowrap tabular-nums'
        }
      >
        <bdi dir="ltr">{formatSignedUsd(entry.amountUnits)}</bdi>
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        <bdi dir="ltr">{formatUsd(entry.balanceAfterUnits)}</bdi>
      </TableCell>
      <TableCell className="min-w-44 whitespace-normal">
        {adjustment ? (
          <span className="flex flex-col gap-1">
            {adjustment.reason}
            {adjustment.adminName && (
              <span className="text-sm text-muted-foreground">
                {t('wallets.detail.byAdmin', { name: adjustment.adminName })}
              </span>
            )}
          </span>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="text-end">
        {reversible && (
          <Button
            variant="outline"
            size="sm"
            aria-label={t('wallets.detail.reverseLabel', {
              amount: formatUsd(Math.abs(entry.amountUnits)),
            })}
            onClick={() => onReverse(entry)}
          >
            <RotateCcwIcon />
            {t('wallets.detail.reverse')}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
