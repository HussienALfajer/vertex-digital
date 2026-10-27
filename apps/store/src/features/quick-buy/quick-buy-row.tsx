'use client';

import { formatUsd, orderTotal, type QuickBuyItem } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vertex-digital/ui/components/dropdown-menu';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Toaster, toast } from '@vertex-digital/ui/components/toast';
import { EllipsisVerticalIcon, EyeOffIcon, Gamepad2Icon, RotateCwIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { setQuickBuyHidden } from '@/features/players/requests';
import { tq } from '@/features/quick-buy/i18n';
import { ltr } from '@/lib/format';
import { mainValue } from './main-value';
import { RowSkeleton } from './quick-buy-slot';
import { getQuickBuy } from './requests';

// The sheet (slide-to-pay, the gap) loads on the first tap of a ready card.
const QuickBuySheet = dynamic(() =>
  import('./quick-buy-sheet').then((module) => module.QuickBuySheet),
);

type State =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'ready'; items: QuickBuyItem[] };

/** QB3: a card that is not ready opens the game page, where the buy box says why. */
const gameLink = (item: QuickBuyItem) =>
  `/games/${item.game.slug}?${new URLSearchParams({
    pack: item.product.id,
    player: item.savedPlayer.id,
  })}`;

/**
 * "اشحن مجدداً" (S22 QB2–QB5): the customer's saved IDs with their last pack at today's price, in
 * a horizontal row of cards. A ready card opens the quick-buy sheet on this page; the others open
 * the game page. "إخفاء" hides a card at once with an undo. A failed read hides the row quietly:
 * the rest of the home page never depends on it.
 */
export function QuickBuyRow() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [open, setOpen] = useState<QuickBuyItem | null>(null);

  useEffect(() => {
    let live = true;
    void getQuickBuy().then((result) => {
      if (!live) return;
      setState(
        result.ok && result.data.items.length > 0
          ? { status: 'ready', items: result.data.items }
          : { status: 'gone' },
      );
    });
    return () => {
      live = false;
    };
  }, []);

  if (state.status === 'loading') return <RowSkeleton />;
  if (state.status === 'gone') return null;

  const restore = (item: QuickBuyItem, at: number) =>
    setState((current) => {
      if (current.status !== 'ready') return { status: 'ready', items: [item] };
      const items = [...current.items];
      items.splice(Math.min(at, items.length), 0, item);
      return { status: 'ready', items };
    });

  async function hide(item: QuickBuyItem) {
    if (state.status !== 'ready') return;
    const at = state.items.indexOf(item);
    setState({ status: 'ready', items: state.items.filter((other) => other !== item) });
    const result = await setQuickBuyHidden(item.savedPlayer.id, true);
    if (!result.ok) {
      restore(item, at);
      toast.add({ title: tq('row.hideFailed'), type: 'error' });
      return;
    }
    toast.add({
      title: tq('row.hidden', { label: item.savedPlayer.label }),
      description: tq('row.hiddenHint'),
      type: 'success',
      actionProps: {
        children: tq('row.undo'),
        onClick: async () => {
          restore(item, at);
          // A refused undo takes the card away again: the server still hides it (audit A03-32).
          if (!(await setQuickBuyHidden(item.savedPlayer.id, false)).ok) {
            setState((current) =>
              current.status === 'ready'
                ? { status: 'ready', items: current.items.filter((other) => other !== item) }
                : current,
            );
            toast.add({ title: tq('row.undoFailed'), type: 'error' });
          }
        },
      },
    });
  }

  return (
    <Toaster closeLabel={tq('row.close')}>
      <section
        aria-labelledby="quick-buy-title"
        className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pt-6"
      >
        <h2 id="quick-buy-title" className="flex items-center gap-2 text-lg font-bold">
          <AscentBar className="h-5 w-1" />
          {tq('row.title')}
        </h2>
        {state.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tq('row.allHidden')}</p>
        ) : (
          <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
            {state.items.map((item) => (
              <li key={item.savedPlayer.id} className="w-64 shrink-0 snap-start">
                <QuickBuyCard item={item} onOpen={() => setOpen(item)} onHide={() => hide(item)} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {open && <QuickBuySheet item={open} onOpenChange={(next) => !next && setOpen(null)} />}
    </Toaster>
  );
}

function QuickBuyCard({
  item,
  onOpen,
  onHide,
}: {
  item: QuickBuyItem;
  onOpen: () => void;
  onHide: () => void;
}) {
  const value = mainValue(item.savedPlayer);
  const price =
    item.unitPriceUsdUnits === null ? null : orderTotal(item.unitPriceUsdUnits, item.quantity);
  const body = (
    <>
      <span className="flex items-center gap-3">
        {item.game.cover ? (
          <CatalogPicture image={item.game.cover} sizes="48px" className="size-12 shrink-0" />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
            <Gamepad2Icon className="size-5 text-muted-foreground" aria-hidden="true" />
          </span>
        )}
        <span className="flex min-w-0 flex-col">
          <bdi className="truncate font-bold">{item.savedPlayer.label}</bdi>
          {value && (
            <bdi dir="ltr" className="text-end text-sm text-muted-foreground tabular-nums">
              {value}
            </bdi>
          )}
        </span>
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <bdi className="truncate text-sm">{item.game.nameAr}</bdi>
          <bdi className="truncate text-sm text-muted-foreground">
            {item.quantity > 1
              ? tq('row.packTimes', { pack: item.product.nameAr, count: item.quantity })
              : item.product.nameAr}
          </bdi>
        </span>
        {price !== null && item.state !== 'unavailable' && (
          <bdi dir="ltr" className="shrink-0 text-lg font-bold tabular-nums">
            {formatUsd(price)}
          </bdi>
        )}
      </span>
      {item.state === 'ready' ? (
        <span className="flex items-center gap-1.5 text-sm font-medium text-accent-text">
          <RotateCwIcon className="size-4" aria-hidden="true" />
          {tq('row.again')}
        </span>
      ) : (
        <Badge tone={item.state === 'unavailable' ? 'neutral' : 'warning'}>
          {tq(`row.states.${item.state}`)}
        </Badge>
      )}
    </>
  );
  const cardClass =
    'flex h-full min-h-36 w-full flex-col gap-3 rounded-xl border border-border bg-surface p-3 pe-12 text-start transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <div className="relative h-full">
      {item.state === 'ready' ? (
        <button
          type="button"
          className={cardClass}
          aria-label={tq('row.openSheet', {
            label: item.savedPlayer.label,
            pack: item.product.nameAr,
            price: price === null ? '' : ltr(formatUsd(price)),
          })}
          onClick={onOpen}
        >
          {body}
        </button>
      ) : (
        <Link href={gameLink(item)} className={cardClass}>
          {body}
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="absolute end-0 top-0 size-11"
              aria-label={tq('row.menu', { label: item.savedPlayer.label })}
            />
          }
        >
          <EllipsisVerticalIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="min-h-11" onClick={onHide}>
            <EyeOffIcon />
            {tq('row.hide')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
