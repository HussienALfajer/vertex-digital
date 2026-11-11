'use client';

import type { ShopGame, ShopProduct } from '@vertex-digital/contracts';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { MousePointerClickIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { PackButton } from '@/features/catalog/pack-button';
import { t } from '@/lib/i18n';
import { useShownAgain } from '@/lib/shown-again';
import type { SellablePack } from './buy-box';
import { ts } from './i18n';
import { shopPackSellable } from './pack-rules';

// The buy box (fields, the player check, the slide) loads once a pack is chosen.
const ShopBuyBox = dynamic(() => import('./buy-box').then((module) => module.ShopBuyBox), {
  loading: () => <Skeleton className="h-96 w-full" />,
});

/** From `lg` the buy box is a sticky side panel; below, a bottom sheet (S09 BB1). */
function useDesktop(): boolean | null {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 64rem)');
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}

const sellable = (product: ShopProduct | undefined): product is SellablePack =>
  !!product && shopPackSellable(product);

/**
 * A shop's packs and buy box (S26 PR5). The chosen pack lives in the URL (`?pack=<id>`), so a
 * sign-in comes back to it; packs not sold wait at the end, greyed.
 */
export function ShopGameShop({
  data,
  cards,
}: {
  data: ShopGame;
  /** Each pack's card content, rendered on the server. */
  cards: Record<string, ReactNode>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const desktop = useDesktop();
  // Back on the page after a purchase: a new buy box and today's prices.
  const shownAgain = useShownAgain();
  useEffect(() => {
    if (shownAgain > 0) router.refresh();
  }, [shownAgain, router]);
  const packId = searchParams.get('pack');
  const selected = data.products.find((product) => product.id === packId);
  const open = sellable(selected) ? selected : null;
  const ready = data.products.filter(sellable);
  const resting = data.products.filter((product) => !sellable(product));

  function choose(id: string | null) {
    const query = id ? `?${new URLSearchParams({ pack: id })}` : '';
    router.replace(`${pathname}${query}`, { scroll: false });
  }

  const box = open && (
    <ShopBuyBox
      key={`${shownAgain}:${open.id}`}
      shop={data.shop}
      game={data.game}
      fields={data.fields}
      product={open}
    />
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <section aria-labelledby="packs-title" className="flex flex-col gap-3">
        <h2 id="packs-title" className="text-lg font-bold">
          {ts('game.packs')}
        </h2>
        {data.products.length === 0 ? (
          <p className="text-sm text-muted-foreground">{ts('game.noPacks')}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[...ready, ...resting].map((product) => (
              <li key={product.id}>
                <PackButton
                  available={sellable(product)}
                  selected={product.id === open?.id}
                  onSelect={() => choose(product.id)}
                >
                  {cards[product.id]}
                </PackButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      {desktop === null ? null : desktop ? (
        <aside className="sticky top-4" aria-label={t('game.buyBox')}>
          <div className="rounded-xl border border-border bg-surface p-5">
            {box || (
              <p className="flex items-center gap-2 text-base text-muted-foreground">
                <MousePointerClickIcon className="size-5" aria-hidden="true" />
                {ts('game.choose')}
              </p>
            )}
          </div>
        </aside>
      ) : (
        <Sheet open={!!open} guardTyped={false} onOpenChange={(next) => !next && choose(null)}>
          <SheetContent side="bottom" className="bg-surface p-5 pb-8">
            <SheetTitle className="sr-only">{t('game.buyBox')}</SheetTitle>
            {box}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
