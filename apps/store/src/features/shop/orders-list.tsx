'use client';

import type { ShopOrderSummary } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ChevronLeftIcon, ReceiptTextIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { STAGE_TONES, stageText } from '@/features/orders/stages';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { ts } from './i18n';
import { ShopMoney } from './money';
import { shopPath } from './paths';
import { listShopOrders } from './requests';
import { ReadFailed, SessionFailed, useSignedInShopCustomer } from './signed-in';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; items: ShopOrderSummary[]; nextCursor: string | null };

/** "طلباتي" in a shop (S26 screens): newest first, 20 at a time, each at its selling price. */
export function ShopOrdersList({ slug }: { slug: string }) {
  const customer = useSignedInShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    const page = await listShopOrders(slug);
    if (current !== generation.current) return;
    setState((shown) =>
      page.ok
        ? { status: 'ready', items: page.data.items, nextCursor: page.data.nextCursor }
        : shown.status === 'ready'
          ? shown
          : { status: 'failed' },
    );
  }, [slug]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  async function more() {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const current = generation.current;
    setLoadingMore(true);
    setMoreFailure(null);
    const page = await listShopOrders(slug, { cursor: state.nextCursor });
    setLoadingMore(false);
    if (current !== generation.current) return;
    if (!page.ok) return setMoreFailure(page.reason);
    setState({
      status: 'ready',
      items: [...state.items, ...page.data.items],
      nextCursor: page.data.nextCursor,
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:py-10">
      <PageHeader title={ts('orders.title')} />
      {customer.status === 'failed' ? (
        <SessionFailed slug={slug} />
      ) : state.status === 'loading' ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {['a', 'b', 'c'].map((key) => (
            <Skeleton key={key} className="h-20 w-full" />
          ))}
        </div>
      ) : state.status === 'failed' ? (
        <ReadFailed title={ts('orders.failed')} onRetry={() => void load()} />
      ) : state.items.length === 0 ? (
        <EmptyState
          icon={<ReceiptTextIcon />}
          title={ts('orders.empty')}
          description={ts('orders.emptyBody')}
          action={
            <Button size="xl" render={<Link href={shopPath(slug)} />}>
              {ts('orders.browse')}
            </Button>
          }
        />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {state.items.map((order) => (
              <li key={order.id}>
                <Link
                  href={shopPath(slug, `/orders/${order.number}`)}
                  prefetch={false}
                  className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 hover:border-(--shop-brand)"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-bold break-words">
                      {order.game.nameAr} · <bdi>{order.productNameAr}</bdi>
                      {order.quantity > 1 && ` × ${order.quantity}`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <bdi dir="ltr">{order.number}</bdi> · {formatDateTime(order.createdAt)}
                    </span>
                    <Badge tone={STAGE_TONES[order.stage]} className="self-start">
                      {stageText(order.stage)}
                    </Badge>
                  </span>
                  <ShopMoney
                    usd={order.totalSellUsdUnits}
                    syp={order.totalSellSypUnits}
                    size="sm"
                  />
                  <ChevronLeftIcon
                    className="size-5 shrink-0 text-muted-foreground ltr:-scale-x-100"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
          {state.nextCursor && (
            <Button variant="outline" size="xl" disabled={loadingMore} onClick={() => void more()}>
              {ts('orders.more')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
