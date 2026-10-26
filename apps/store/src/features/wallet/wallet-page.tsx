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
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@vertex-digital/ui/components/collapsible';
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import {
  isMoneyEvent,
  useNotificationEvents,
  useVisibleAgain,
} from '@/features/notifications/live';
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

/** A burst of live events (a bulk checkout's orders) is read once, this long after the last. */
const REFRESH_DEBOUNCE_MS = 500;

/** An entry's identity on screen: entries are never rewritten, so these never change. */
const entryKey = (entry: WalletEntry) =>
  `${entry.occurredAt}:${entry.balanceAfterUnits}:${entry.amountUnits}`;

/**
 * The newest page laid over the entries already loaded (audit A02-4): entries are append-only and
 * an older entry's running balance never changes, so the loaded pages stay, under the new ones.
 * When the newest page does not reach the loaded entries (more than a page arrived), it starts
 * the list again with its own cursor.
 */
export function mergeNewest(
  loaded: { entries: WalletEntry[]; nextCursor: string | null },
  newest: { items: WalletEntry[]; nextCursor: string | null },
): { entries: WalletEntry[]; nextCursor: string | null } {
  const oldest = newest.items.at(-1);
  if (!oldest) return { entries: [], nextCursor: null };
  const at = loaded.entries.findIndex((entry) => entryKey(entry) === entryKey(oldest));
  if (at === -1) return { entries: newest.items, nextCursor: newest.nextCursor };
  return {
    entries: [...newest.items, ...loaded.entries.slice(at + 1)],
    nextCursor: loaded.nextCursor,
  };
}

const KIND_ICONS: Record<JournalKind, LucideIcon> = {
  deposit: ArrowDownToLineIcon,
  purchase: ShoppingBagIcon,
  refund: Undo2Icon,
  cost_of_goods: ReceiptTextIcon,
  adjustment: SlidersHorizontalIcon,
  treasury: SlidersHorizontalIcon,
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
  // Each full read starts a new generation: an answer of an older read, or a next page asked for
  // the list a newer read replaced, is dropped, so a slow answer never brings back an old balance
  // or splices a page into a list it does not follow (audit A7).
  const generation = useRef(0);

  /**
   * Reads the balance and the newest page. A refresh (a live event, the tab shown again) keeps the
   * pages loaded and, when it fails, what is on screen (audit A02-4, A02-6).
   */
  const load = useCallback(
    async (refresh = false) => {
      const current = ++generation.current;
      const [wallet, page] = await Promise.all([getWallet(), listWalletEntries()]);
      if (current !== generation.current) return;
      if (!wallet.ok && wallet.reason === 'UNAUTHORIZED') {
        router.replace('/sign-in?next=%2Fwallet');
        return;
      }
      if (!wallet.ok || !page.ok) {
        if (!refresh) setState({ status: 'failed' });
        return;
      }
      setState((previous) => ({
        status: 'ready',
        wallet: wallet.data,
        ...(refresh && previous.status === 'ready'
          ? mergeNewest(previous, page.data)
          : { entries: page.data.items, nextCursor: page.data.nextCursor }),
      }));
    },
    [router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(true), REFRESH_DEBOUNCE_MS);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // What moves the balance arrives live (S05 rule NT7): a credit, an adjustment, a refund, a
  // purchase's order; tickets and alerts do not (audit A02-4).
  useNotificationEvents((event) => {
    if (isMoneyEvent(event) || event.type === 'order') refresh();
  });
  useVisibleAgain(refresh);

  const loadMore = async (cursor: string) => {
    setMoreFailure(null);
    setLoadingMore(true);
    const current = generation.current;
    const page = await listWalletEntries(cursor);
    setLoadingMore(false);
    if (current !== generation.current) return;
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
        {entry.order && (
          <Link
            href={`/orders/${entry.order.id}`}
            className="inline-flex min-h-11 w-fit items-center text-sm text-primary underline-offset-4 hover:underline"
          >
            <bdi dir="ltr">{entry.order.number}</bdi>
          </Link>
        )}
        {entry.checkout && (
          // S10 (W5): a checkout's one entry opens to its orders.
          <Collapsible>
            <CollapsibleTrigger className="min-h-11 w-fit gap-2 text-sm text-primary">
              {t('wallet.checkoutOrders')}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ul className="flex flex-col gap-1 pb-1 text-sm">
                {entry.checkout.orders.map((order) => (
                  <li key={order.id} className="flex flex-wrap items-baseline gap-x-2">
                    <bdi>{order.productNameAr}</bdi>
                    <Link
                      href={`/orders/${order.id}`}
                      className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                    >
                      <bdi dir="ltr">{order.number}</bdi>
                    </Link>
                  </li>
                ))}
                <li>
                  <Link
                    href={`/orders?checkout=${entry.checkout.id}`}
                    className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                  >
                    {t('wallet.checkoutView')}
                  </Link>
                </li>
              </ul>
            </CollapsiblePanel>
          </Collapsible>
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
