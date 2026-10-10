'use client';

import type { StoreGame, StoreProduct } from '@vertex-digital/contracts';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { MousePointerClickIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Buyable, BuyBoxIntent } from '@/features/purchase/buy-box';
import { useCustomer } from '@/features/purchase/session';
import { t } from '@/lib/i18n';
import { CalculatorCard, calculatorPacks } from './calculator-card';
import { PackButton } from './pack-button';

// The buy box (its field rules, the player check, slide-to-pay) loads once a pack is chosen, so
// the game page's first load stays light (apps/store/CLAUDE.md, the game page's budget).
const BuyBox = dynamic(
  () => import('@/features/purchase/buy-box').then((module) => module.BuyBox),
  {
    loading: () => <Skeleton className="h-96 w-full" />,
  },
);

/**
 * From `lg` the buy box is a sticky side panel; below, a bottom sheet (rule BB1). Null until the
 * browser answers, so the box never mounts in the wrong place first.
 */
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

const buyable = (product: StoreProduct | undefined): product is Buyable =>
  !!product && product.available && product.priceUsdUnits !== null;

/**
 * The packs of a game page with the calculator and the buy box (rules SF2, CL1–CL3, BB1). The
 * chosen pack lives in the URL (`?pack=<id>`), so a sign-in, a search result or the calculator
 * comes back to it; an unknown or unavailable pack in the URL opens nothing. S10 adds what opened
 * the box, read once from the URL: `?repeat=<order>` (OT1, the pack read from the order when the
 * link has none), `?player=<saved id>` (SP5) and `?line=<cart line>` (CT6), and the calculator's
 * "أضف الكل إلى السلة" (CT3).
 */
export function GameShop({
  data,
  cards,
}: {
  data: StoreGame;
  /** Each pack's card content, rendered on the server (`PackContent`). */
  cards: Record<string, ReactNode>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const desktop = useDesktop();
  const customer = useCustomer();
  const [quantity, setQuantity] = useState(1);
  const [intent, setIntent] = useState<BuyBoxIntent | undefined>();
  const [repeatFailed, setRepeatFailed] = useState(false);
  const packId = searchParams.get('pack');
  const selected = data.products.find((product) => product.id === packId);
  const open = buyable(selected) ? selected : null;
  const packs = calculatorPacks(data.products);

  function choose(id: string | null, count = 1, next?: BuyBoxIntent) {
    setQuantity(count);
    // A saved ID stays chosen across packs; a repeat, an edited line or the calculator's packs
    // belong to the pack they opened.
    setIntent((current) => next ?? (current?.kind === 'player' ? current : undefined));
    const query = id ? `?${new URLSearchParams({ pack: id })}` : '';
    router.replace(`${pathname}${query}`, { scroll: false });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the URL the page opened at.
  useEffect(() => {
    const repeat = searchParams.get('repeat');
    const player = searchParams.get('player');
    const line = searchParams.get('line');
    if (line) return setIntent({ kind: 'edit', lineId: line });
    if (player) return setIntent({ kind: 'player', savedId: player });
    if (!repeat) return;
    const next: BuyBoxIntent = { kind: 'repeat', orderId: repeat };
    if (packId) {
      setIntent(next);
      if (!buyable(selected)) setRepeatFailed(true);
      return;
    }
    // Rule OT1 from "طلباتي": the order says which pack it was.
    void import('@/features/orders/requests')
      .then(({ getOrder }) => getOrder(repeat))
      .then((result) => {
        const product = result.ok
          ? data.products.find((item) => item.id === result.data.product.id)
          : undefined;
        if (!product || !buyable(product)) return setRepeatFailed(true);
        choose(product.id, 1, next);
      });
  }, []);

  const box = open && (
    <BuyBox
      key={`${open.id}:${quantity}:${intent?.kind ?? ''}`}
      game={data.game}
      fields={data.fields}
      product={open}
      customer={customer}
      initialQuantity={quantity}
      intent={intent}
    />
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex flex-col gap-6">
        {repeatFailed && <FormAlert>{t('purchase.repeat.unavailable')}</FormAlert>}
        <section aria-labelledby="packs-title" className="flex flex-col gap-3">
          <h2 id="packs-title" className="text-lg font-bold">
            {t('game.packs')}
          </h2>
          {data.products.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('game.noPacks')}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {data.products.map((product) => (
                <li key={product.id}>
                  <PackButton
                    available={buyable(product)}
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
        {packs.length >= 2 && (
          <CalculatorCard
            packs={packs}
            onBuy={(id, count) => choose(id, count)}
            onAddAll={(lines) => {
              const first = lines[0];
              if (!first) return;
              choose(first.product.id, 1, { kind: 'bundle', lines });
            }}
          />
        )}
      </div>
      {desktop === null ? null : desktop ? (
        <aside className="sticky top-4" aria-label={t('game.buyBox')}>
          <div className="rounded-xl border border-border bg-surface p-5">
            {box || (
              <p className="flex items-center gap-2 text-base text-muted-foreground">
                <MousePointerClickIcon className="size-5" aria-hidden="true" />
                {t('game.choosePack')}
              </p>
            )}
          </div>
        </aside>
      ) : (
        <Sheet open={!!open} onOpenChange={(next) => !next && choose(null)}>
          <SheetContent side="bottom" className="bg-surface p-5 pb-8">
            <SheetTitle className="sr-only">{t('game.buyBox')}</SheetTitle>
            {box}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
