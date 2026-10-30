'use client';

import type { StoreGame } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useParams } from 'next/navigation';
import { type ReactNode, Suspense, useEffect, useState } from 'react';
import { useCustomer } from '@/features/purchase/session';
import { t } from '@/lib/i18n';
import { readEarlyAccessGame } from './customer-prices';
import { accentStyle } from './game-card';
import { GameShop } from './game-shop';
import { PackContent } from './pack-card';

/**
 * S23 OP5, edge case 13: a game in early access is not found on the cached page. For a merchant of
 * an early-access tier the not-found view reads the game in the browser and shows it with its
 * packs and the "وصول مبكر" chip; anyone else keeps the not-found view (`children`).
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

  if (game === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8" aria-hidden="true">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (game === null) return children;
  return (
    <div style={accentStyle(game.game.accentColor)} className="flex flex-col">
      <div aria-hidden="true" className="h-2 bg-(--game-accent)" />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:py-10">
        <header className="flex flex-col gap-2">
          <Badge tone="gold" className="self-start">
            {t('catalog.earlyAccess')}
          </Badge>
          <h1 className="text-2xl font-bold break-words md:text-3xl">
            {t('game.title', { name: game.game.nameAr })}
          </h1>
          <p dir="ltr" className="text-end text-sm text-muted-foreground">
            {game.game.nameEn}
          </p>
        </header>
        <Suspense>
          <GameShop
            data={game}
            cards={Object.fromEntries(
              game.products.map((product) => [
                product.id,
                <PackContent key={product.id} product={product} cached={false} />,
              ]),
            )}
          />
        </Suspense>
      </div>
    </div>
  );
}
