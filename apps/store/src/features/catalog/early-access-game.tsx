'use client';

import type { StoreGame } from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { useCustomer } from '@/features/purchase/session';
import { t } from '@/lib/i18n';
import { readEarlyAccessGame } from './customer-prices';

// Every game page imports this file: the game's view (money formatting, the shop) loads once a
// merchant's game is read, so the page's first load stays light (apps/store/CLAUDE.md).
const EarlyGameView = dynamic(() =>
  import('./early-game-view').then((module) => module.EarlyGameView),
);

/**
 * S23 OP5, edge case 13: a game in early access is not found on the cached page. For a merchant of
 * an early-access tier the page reads the game in the browser and shows it with its packs and the
 * "وصول مبكر" chip; anyone else keeps the not-found view (`children`).
 */
export function EarlyAccessGame({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const customer = useCustomer();
  const [game, setGame] = useState<StoreGame | null | 'loading'>('loading');
  const merchant = customer.status === 'signedIn' && customer.verified && customer.merchant;

  useEffect(() => {
    if (customer.status === 'loading') return;
    if (!merchant || typeof slug !== 'string') return setGame(null);
    let live = true;
    void readEarlyAccessGame(slug).then((read) => {
      if (live) setGame(read);
    });
    return () => {
      live = false;
    };
  }, [customer.status, merchant, slug]);

  // The server's title says not found: the merchant's tab names the game once it is read.
  const name = game && game !== 'loading' ? game.game.nameAr : null;
  useEffect(() => {
    if (name) document.title = t('game.metaTitle', { name });
  }, [name]);

  if (game === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8" aria-hidden="true">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (game === null) return children;
  return <EarlyGameView game={game} />;
}
