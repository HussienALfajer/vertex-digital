'use client';

import {
  formatRate,
  formatSignedUsd,
  formatSyp,
  formatUsd,
  type JournalKind,
  type Wallet,
  type WalletEntry,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  ArrowDownToLineIcon,
  CircleAlertIcon,
  HistoryIcon,
  type LucideIcon,
  ReceiptTextIcon,
  RotateCcwIcon,
  ShoppingBagIcon,
  SlidersHorizontalIcon,
  Undo2Icon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { useNotificationEvents } from '@/features/notifications/live';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { entryLabel } from './labels';
import { getWallet, listWalletEntries } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; wallet: Wallet; entries: WalletEntry[]; nextCursor: string | null };

const KIND_ICONS: Record<JournalKind, LucideIcon> = {
  deposit: ArrowDownToLineIcon,
  purchase: ShoppingBagIcon,
  refund: Undo2Icon,
  cost_of_goods: ReceiptTextIcon,
  adjustment: SlidersHorizontalIcon,
};

/**
 * The customer's wallet (S02 screens): the balance card and the timeline with its running
 * balance, newest first, 30 at a time (rules W3–W7). Read in the browser, never cached (W10);
 * without a session the customer signs in and comes back here.
 */
export function WalletPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const [wallet, page] = await Promise.all([getWallet(), listWalletEntries()]);
    if (!wallet.ok && wallet.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Fwallet');
      return;
    }
    if (!wallet.ok || !page.ok) return setState({ status: 'failed' });
    setState({
      status: 'ready',
      wallet: wallet.data,
      entries: page.data.items,
      nextCursor: page.data.nextCursor,
    });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  // A credit, an adjustment or any deposit decision arrives live (S05 rule NT7): read again.
  useNotificationEvents((event) => {
    if (event.type !== 'unread') void load();
  });

  const loadMore = async (cursor: string) => {
    setMoreFailure(null);
    setLoadingMore(true);
    const page = await listWalletEntries(cursor);
    setLoadingMore(false);
    if (!page.ok) return setMoreFailure(page.reason);
    setState((previous) =>
      previous.status === 'ready'
        ? {
            ...previous,
            entries: [...previous.entries, ...page.data.items],
            nextCursor: page.data.nextCursor,
          }
        : previous,
    );
  };

  if (state.status === 'loading') return <WalletSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('wallet.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('wallet.retry')}
          </Button>
        }
      />
    );
  }

  const { wallet, entries, nextCursor } = state;
  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-base text-muted-foreground">{t('wallet.balance')}</p>
          <p className="text-3xl font-bold tabular-nums" dir="ltr">
            <bdi>{formatUsd(wallet.balanceUnits)}</bdi>
          </p>
          {wallet.syp && (
            // Under the balance, which reads left to right.
            <p className="self-end text-sm text-muted-foreground tabular-nums">
              {t('wallet.syp', { amount: formatSyp(wallet.syp.valueUnits) })}{' '}
              {t('wallet.sypRate', { rate: formatRate(wallet.syp.rate) })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xl" render={<Link href="/wallet/deposit" />}>
            <ArrowDownToLineIcon />
            {t('wallet.deposit')}
          </Button>
          <Button variant="outline" size="xl" render={<Link href="/wallet/deposits" />}>
            <HistoryIcon />
            {t('wallet.myDeposits')}
          </Button>
        </div>
      </Card>
      <section className="flex flex-col gap-3" aria-labelledby="wallet-timeline">
        <h2 id="wallet-timeline" className="text-lg font-bold">
          {t('wallet.timeline')}
        </h2>
        {entries.length === 0 ? (
          <EmptyState icon={<WalletIcon />} title={t('wallet.emptyTitle')} />
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {entries.map((entry) => (
              <EntryRow
                key={`${entry.occurredAt}:${entry.balanceAfterUnits}:${entry.amountUnits}`}
                entry={entry}
              />
            ))}
          </ul>
        )}
        {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
        {nextCursor && (
          <Button
            variant="outline"
            size="xl"
            className="self-center"
            disabled={loadingMore}
            onClick={() => void loadMore(nextCursor)}
          >
            {loadingMore ? t('wallet.loadingMore') : t('wallet.loadMore')}
          </Button>
        )}
      </section>
    </div>
  );
}

function EntryRow({ entry }: { entry: WalletEntry }) {
  const Icon = entry.adjustment?.reversal ? RotateCcwIcon : KIND_ICONS[entry.kind];
  const credit = entry.amountUnits > 0;
  return (
    <li className="flex items-start gap-3 p-4">
      <IconTile tone={credit ? 'success' : 'muted'}>
        <Icon />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">{entryLabel(entry)}</p>
        {entry.deposit && (
          <p className="text-sm text-muted-foreground tabular-nums">
            <bdi dir="ltr">{entry.deposit.referenceCode}</bdi>
            {entry.deposit.syp && (
              <>
                {' · '}
                {t('wallet.depositSyp', {
                  amount: formatSyp(entry.deposit.syp.amountUnits),
                  rate: formatRate(entry.deposit.syp.rate),
                })}
              </>
            )}
          </p>
        )}
        {entry.adjustment?.customerNote && (
          <p className="text-sm break-words text-muted-foreground">
            {entry.adjustment.customerNote}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{formatDateTime(entry.occurredAt)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-end">
        <p
          className={
            credit
              ? 'font-bold text-status-success-foreground tabular-nums'
              : 'font-bold tabular-nums'
          }
        >
          <bdi dir="ltr">{formatSignedUsd(entry.amountUnits)}</bdi>
        </p>
        <p className="text-xs text-muted-foreground">
          {t('wallet.balanceAfter')}{' '}
          <bdi dir="ltr" className="tabular-nums">
            {formatUsd(entry.balanceAfterUnits)}
          </bdi>
        </p>
      </div>
    </li>
  );
}

/** The card and the timeline's shapes while the wallet loads. */
function WalletSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Card className="gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-10 w-40" />
      </Card>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-28" />
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}
