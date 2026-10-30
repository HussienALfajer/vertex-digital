'use client';

import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { type MerchantAccount, setSaleMode, useMerchantAccount, useSaleMode } from './sale-mode';

/** The sidebar's width and the bar's height, only where the last read was a merchant's. */
function ToolsPlaceholder() {
  return (
    <>
      <div
        aria-hidden="true"
        className="sticky top-0 hidden h-dvh w-64 self-start bg-sidebar [[data-merchant-hint]_&]:lg:col-start-1 [[data-merchant-hint]_&]:lg:row-span-2 [[data-merchant-hint]_&]:lg:row-start-1 [[data-merchant-hint]_&]:lg:block"
      />
      <div
        aria-hidden="true"
        className="hidden h-17 border-b border-border [[data-merchant-hint]_&]:block [[data-merchant-hint]_&]:lg:col-start-2 [[data-merchant-hint]_&]:lg:row-start-1"
      />
    </>
  );
}

const HomeTools = dynamic(() => import('./home-tools').then((module) => module.HomeTools), {
  loading: () => <ToolsPlaceholder />,
});

const SaleGamesRow = dynamic(
  () => import('./sale-games-row').then((module) => module.SaleGamesRow),
  { loading: () => <GamesPlaceholder /> },
);

function GamesPlaceholder() {
  return (
    <div
      className="mx-auto hidden w-full max-w-6xl flex-col gap-4 px-4 pt-6 [[data-sale-mode-hint]_&]:flex"
      aria-hidden="true"
    >
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-52 w-full" />
    </div>
  );
}

/**
 * `/?sale=1` (the sections' link, the old `/merchant/pos`) turns the sale mode on and leaves the
 * address; a visitor signs in first and comes back to it. Its own boundary: the page stays static.
 */
function SaleParam({ account }: { account: MerchantAccount }) {
  const router = useRouter();
  const asked = useSearchParams().has('sale');
  useEffect(() => {
    if (!asked || account === 'loading') return;
    if (account === 'signedOut') {
      router.replace(`/sign-in?next=${encodeURIComponent('/?sale=1')}`);
      return;
    }
    if (account === 'merchant') setSaleMode(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('sale');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }, [asked, account, router]);
  return null;
}

/**
 * The home page's slot for the merchant's tools (S21 PS1): nothing in the cached page, and nothing
 * at all for a customer or a visitor, whose page never moves.
 */
export function HomeMerchantSlot() {
  const account = useMerchantAccount();
  return (
    <>
      <Suspense fallback={null}>
        <SaleParam account={account} />
      </Suspense>
      {account === 'loading' ? <ToolsPlaceholder /> : account === 'merchant' && <HomeTools />}
    </>
  );
}

/** "ألعابك" under the search (S21 PS1), only while the sale mode is on. */
export function SaleGamesSlot() {
  const account = useMerchantAccount();
  const on = useSaleMode();
  if (account === 'loading') return <GamesPlaceholder />;
  return account === 'merchant' && on ? <SaleGamesRow /> : null;
}
