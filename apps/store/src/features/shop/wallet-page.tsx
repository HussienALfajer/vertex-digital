'use client';

import { formatSignedUsd, formatUsd, type ShopWalletEntryPage } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { ts } from './i18n';
import { balanceSyp, ShopMoney } from './money';
import { shopPath } from './paths';
import { listShopWalletEntries } from './requests';
import { ReturnRequestCard } from './return-request-card';
import { ReadFailed, SessionFailed, useSignedInShopCustomer } from './signed-in';
import { refreshShopWallet, useShopWallet } from './wallet';

type Entry = ShopWalletEntryPage['items'][number];

type Entries =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; items: Entry[]; nextCursor: string | null };

/**
 * "رصيدي" (S26 screens): the balance SYP first, the pending return request, and the timeline
 * (transfers, purchases, refunds, returns), newest first. Read in the browser, never cached.
 */
export function ShopWalletPage({ slug }: { slug: string }) {
  const customer = useSignedInShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const { state } = useShopWallet(slug, signedIn);
  const [entries, setEntries] = useState<Entries>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    const page = await listShopWalletEntries(slug);
    if (current !== generation.current) return;
    // A failed refresh keeps the movements shown.
    setEntries((shown) =>
      page.ok
        ? { status: 'ready', items: page.data.items, nextCursor: page.data.nextCursor }
        : shown.status === 'ready'
          ? shown
          : { status: 'failed' },
    );
  }, [slug]);

  // Read again whenever the balance changes (a confirmed return, a purchase elsewhere): the
  // newest movement belongs at the top.
  const balance = state.status === 'ready' ? state.wallet.balanceUsdUnits : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new balance is the trigger.
  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load, balance]);

  async function more() {
    if (entries.status !== 'ready' || !entries.nextCursor) return;
    const current = generation.current;
    setLoadingMore(true);
    setMoreFailure(null);
    const page = await listShopWalletEntries(slug, { cursor: entries.nextCursor });
    setLoadingMore(false);
    if (current !== generation.current) return;
    if (!page.ok) return setMoreFailure(page.reason);
    setEntries({
      status: 'ready',
      items: [...entries.items, ...page.data.items],
      nextCursor: page.data.nextCursor,
    });
  }

  const header = <PageHeader title={ts('wallet.title')} />;
  if (customer.status === 'failed')
    return (
      <Frame header={header}>
        <SessionFailed slug={slug} />
      </Frame>
    );
  if (customer.status !== 'signedIn' || state.status === 'loading') {
    return (
      <Frame header={header}>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </Frame>
    );
  }
  if (state.status === 'failed') {
    return (
      <Frame header={header}>
        <ReadFailed title={ts('wallet.failed')} onRetry={() => void refreshShopWallet(slug)} />
      </Frame>
    );
  }
  const { balanceUsdUnits, rate } = state.wallet;
  return (
    <Frame header={header}>
      <section
        aria-label={ts('balance.label')}
        className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-5"
      >
        <span className="text-sm text-muted-foreground">{ts('balance.label')}</span>
        <ShopMoney usd={balanceUsdUnits} syp={balanceSyp(balanceUsdUnits, rate)} size="lg" />
      </section>
      <ReturnRequestCard slug={slug} />
      {balanceUsdUnits === 0 && (
        <EmptyState
          icon={<WalletIcon />}
          title={ts('wallet.empty')}
          description={ts('wallet.emptyBody')}
        />
      )}
      <section aria-labelledby="timeline-title" className="flex flex-col gap-3">
        <h2 id="timeline-title" className="text-lg font-bold">
          {ts('wallet.timeline')}
        </h2>
        {entries.status === 'loading' ? (
          <Skeleton className="h-40 w-full" />
        ) : entries.status === 'failed' ? (
          <ReadFailed title={ts('wallet.failed')} onRetry={() => void load()} />
        ) : entries.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{ts('wallet.noEntries')}</p>
        ) : (
          <ul className="flex flex-col rounded-xl border border-border bg-surface">
            {entries.items.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{ts(`wallet.kinds.${entry.kind}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <bdi
                    dir="ltr"
                    className={`font-bold tabular-nums ${entry.amountUnits >= 0 ? 'text-status-success-foreground' : ''}`}
                  >
                    {formatSignedUsd(entry.amountUnits)}
                  </bdi>
                  <bdi dir="ltr" className="text-xs text-muted-foreground tabular-nums">
                    {formatUsd(entry.balanceAfterUnits)}
                  </bdi>
                </span>
              </li>
            ))}
          </ul>
        )}
        {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
        {entries.status === 'ready' && entries.nextCursor && (
          <Button variant="outline" size="xl" disabled={loadingMore} onClick={() => void more()}>
            {ts('wallet.more')}
          </Button>
        )}
      </section>
      <Link
        href={shopPath(slug)}
        prefetch={false}
        className="self-start text-sm font-medium underline underline-offset-4"
      >
        {ts('back.home')}
      </Link>
    </Frame>
  );
}

function Frame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:py-10">
      {header}
      {children}
    </div>
  );
}
