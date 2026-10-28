'use client';

import type { StoreGame, StoreProduct } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ChevronDownIcon, MousePointerClickIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Buyable, BuyBoxIntent } from '@/features/purchase/buy-box';
import { useCustomer } from '@/features/purchase/session';
import { takeQuickLinkCookie } from '@/features/quick-links/handoff';
import { t } from '@/lib/i18n';
import { CalculatorCard, calculatorPacks } from './calculator-card';
import { PackButton } from './pack-button';
import { usePrivatePrices } from './private-prices';

// S20: an account's own prices render their cards in the browser; retail accounts never load it.
const PrivatePackContent = dynamic(() =>
  import('./pack-card').then((module) => module.PackContent),
);

// The buy box (its field rules, the player check, slide-to-pay) loads once a pack is chosen, so
// the game page's first load stays light (apps/store/CLAUDE.md, the game page's budget).
/** S22 PA1: "نبّهني عند التوفر" under an unavailable pack, with its own catalog. */
const AlertButton = dynamic(() =>
  import('@/features/product-alerts/alert-button').then((module) => module.AlertButton),
);

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
 * "أضف الكل إلى السلة" (CT3). S22 DL2, DL3: `?via=q` after a direct link keeps the link for the
 * order and picks the newest-used saved ID.
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
  const prices = usePrivatePrices(data.game.slug, customer, data.products);
  const products = prices.status === 'ready' ? prices.products : data.products;
  // AT4: no buy while an account's own prices are unknown (its last read had them, or it failed).
  const waiting = prices.status === 'failed' || (prices.status === 'loading' && prices.hinted);
  const [quantity, setQuantity] = useState(1);
  const [restingOpen, setRestingOpen] = useState(false);
  const [intent, setIntent] = useState<BuyBoxIntent | undefined>();
  const [repeatFailed, setRepeatFailed] = useState(false);
  const packId = searchParams.get('pack');
  const selected = products.find((product) => product.id === packId);
  const open = buyable(selected) && !waiting ? selected : null;
  const packs = calculatorPacks(products);
  // The packs that can be bought lead; the others wait folded at the end (2026-10-19).
  const ready = products.filter(buyable);
  const resting = products.filter((product) => !buyable(product));
  const card = (product: StoreProduct) =>
    prices.status === 'ready' ? (
      <PrivatePackContent product={product} cached={false} />
    ) : (
      cards[product.id]
    );

  function choose(id: string | null, count = 1, next?: BuyBoxIntent) {
    setQuantity(count);
    // A saved ID stays chosen across packs; a repeat, an edited line, the calculator's packs or a
    // direct link belong to the pack they opened.
    setIntent(
      (current) => next ?? (current?.kind === 'player' ? { ...current, jump: false } : undefined),
    );
    const query = id ? `?${new URLSearchParams({ pack: id })}` : '';
    router.replace(`${pathname}${query}`, { scroll: false });
  }

  // What the URL asks of the buy box: read when the page opens and again when a search command
  // changes it on this same page (S22 SC3, audit A03-9); `choose` drops these keys.
  const asked = ['repeat', 'player', 'line', 'via'].map((key) => searchParams.get(key)).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` holds the parameters read.
  useEffect(() => {
    const repeat = searchParams.get('repeat');
    const player = searchParams.get('player');
    const line = searchParams.get('line');
    if (line) return setIntent({ kind: 'edit', lineId: line });
    // S22 SC3, QB3: with its pack in the URL, a ready saved ID opens the slide step.
    if (player) return setIntent({ kind: 'player', savedId: player, jump: !!packId });
    if (searchParams.get('via') === 'q') {
      takeQuickLinkCookie();
      return setIntent({ kind: 'link' });
    }
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
          ? products.find((item) => item.id === result.data.product.id)
          : undefined;
        if (!product || !buyable(product)) return setRepeatFailed(true);
        choose(product.id, 1, next);
      });
  }, [asked]);

  const box = open && (
    <BuyBox
      key={`${open.id}:${quantity}:${intent?.kind ?? ''}:${intent?.kind === 'player' ? intent.savedId : ''}`}
      game={data.game}
      fields={data.fields}
      product={open}
      customer={customer}
      initialQuantity={quantity}
      intent={intent}
    />
  );

  // A list that opens itself (all packs resting, or a link to a resting pack) shows its alerts
  // at once: its `toggle` may fire before hydration, so it cannot be waited for.
  const restingDefaultOpen = ready.length === 0 || resting.some((product) => product.id === packId);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex flex-col gap-6">
        {repeatFailed && <FormAlert>{t('purchase.repeat.unavailable')}</FormAlert>}
        {prices.status === 'failed' && (
          <div className="flex flex-wrap items-center gap-3">
            <FormAlert>{t('game.privatePrices.failed')}</FormAlert>
            <Button variant="outline" size="xl" onClick={prices.retry}>
              {t('game.privatePrices.retry')}
            </Button>
          </div>
        )}
        <section aria-labelledby="packs-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="packs-title" className="text-lg font-bold">
              {t('game.packs')}
            </h2>
            {prices.status === 'ready' && (
              <Badge tone="gold">{t(`game.privatePrices.kinds.${prices.kind}`)}</Badge>
            )}
          </div>
          {data.products.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('game.noPacks')}</p>
          ) : (
            ready.length > 0 && (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {ready.map((product) => (
                  <li key={product.id}>
                    <PackButton
                      available={!waiting}
                      selected={product.id === open?.id}
                      onSelect={() => choose(product.id)}
                    >
                      {card(product)}
                    </PackButton>
                  </li>
                ))}
              </ul>
            )
          )}
        </section>
        {packs.length >= 2 && !waiting && (
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
        {resting.length > 0 && (
          <details
            className="group rounded-lg border border-border bg-surface"
            open={restingDefaultOpen}
            onToggle={(event) => setRestingOpen(event.currentTarget.open)}
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
              {t('game.unavailable', { count: resting.length })}
              <ChevronDownIcon
                className="size-4 transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <ul className="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-3">
              {resting.map((product) => (
                <li key={product.id} className="flex flex-col gap-2">
                  <PackButton available={false} selected={false} onSelect={() => {}}>
                    {card(product)}
                  </PackButton>
                  {/* Loaded once the list is open: the game page's first load stays in budget. */}
                  {(restingOpen || restingDefaultOpen) && (
                    <AlertButton productId={product.id} gameId={data.game.id} kind="available" />
                  )}
                </li>
              ))}
            </ul>
          </details>
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
