'use client';

import type { StoreGame } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Suspense } from 'react';
import { PageBackLink } from '@/components/page-back-link';
import { t } from '@/lib/i18n';
import { accentStyle } from './game-card';
import { GameShop } from './game-shop';
import { PackContent } from './pack-card';

/** S23 OP5: a game in early access, with its packs and the "وصول مبكر" chip. */
export function EarlyGameView({ game }: { game: StoreGame }) {
  return (
    <div style={accentStyle(game.game.accentColor)} className="flex flex-col">
      <div aria-hidden="true" className="h-2 bg-(--game-accent)" />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:py-10">
        <PageBackLink href="/">{t('back.home')}</PageBackLink>
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
