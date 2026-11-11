'use client';

import { formatUsd, type ShopOrder } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleHelpIcon, EyeIcon, UserRoundCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { PageBackLink } from '@/components/page-back-link';
import { CopyButton } from '@/features/deposits/copy-button';
import { to } from '@/features/orders/i18n';
import {
  STAGE_TONES,
  stageSentence,
  stageText,
  stepText,
  timelineEntries,
} from '@/features/orders/stages';
import { LazyVerificationQr } from '@/features/orders/verification-qr-lazy';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { ts } from './i18n';
import { ShopMoney } from './money';
import { ShopNotFound } from './not-found-view';
import { shopPath } from './paths';
import { getShopOrder, revealShopCode } from './requests';
import { ReadFailed, SessionFailed, useSignedInShopCustomer } from './signed-in';
import { refreshShopWallet } from './wallet';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; order: ShopOrder; stale?: boolean };

/** S09 LT2 in a shop: an open order is read again this often while the page is shown. */
const POLL_MS = 5_000;

const OPEN = new Set<ShopOrder['stage']>(['processing', 'delayed']);

/**
 * One shop order (S26 screens, PR9, PR11, PR12): the stage and its sentence, the timeline, the
 * player's name, the fields, each code masked until revealed, the selling price SYP first, what
 * was refunded or compensated, the receipt's verification QR, and "مشكلة في الطلب؟". Read in the
 * browser, never cached; another customer's order is the shop's 404. An open order is read again
 * every few seconds until it finishes, then the balance is read again (a refund).
 */
export function ShopOrderPage({ slug, number }: { slug: string; number: string }) {
  const customer = useSignedInShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const [state, setState] = useState<State>({ status: 'loading' });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const read = ++latest.current;
    const result = await getShopOrder(slug, number);
    if (read !== latest.current) return;
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') return setState({ status: 'missing' });
      return setState((current) =>
        current.status === 'ready' ? { ...current, stale: true } : { status: 'failed' },
      );
    }
    setState((current) => {
      if (
        current.status === 'ready' &&
        OPEN.has(current.order.stage) &&
        !OPEN.has(result.data.stage)
      ) {
        void refreshShopWallet(slug);
      }
      return { status: 'ready', order: result.data };
    });
  }, [slug, number]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const open = state.status === 'ready' && OPEN.has(state.order.stage);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  const back = <PageBackLink href={shopPath(slug, '/orders')}>{ts('back.orders')}</PageBackLink>;
  if (customer.status === 'failed')
    return (
      <Frame back={back}>
        <SessionFailed slug={slug} />
      </Frame>
    );
  if (state.status === 'missing') return <ShopNotFound />;
  if (state.status === 'loading') {
    return (
      <Frame back={back}>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </Frame>
    );
  }
  if (state.status === 'failed') {
    return (
      <Frame back={back}>
        <ReadFailed title={ts('orders.failed')} onRetry={() => void load()} />
      </Frame>
    );
  }
  const { order } = state;
  return (
    <Frame back={back}>
      <PageHeader
        title={ts('orders.number', { number: order.number })}
        description={formatDateTime(order.createdAt)}
      />
      {state.stale && <FormAlert tone="warning">{errorText('NETWORK')}</FormAlert>}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <Badge tone={STAGE_TONES[order.stage]} className="self-start">
          {stageText(order.stage)}
        </Badge>
        <p className="text-base">{stageSentence(order)}</p>
        {open && <p className="text-xs text-muted-foreground">{ts('orders.live')}</p>}
        {order.refundedUsdUnits > 0 && (
          <p className="text-sm font-medium">
            {ts('orders.refunded', { amount: ltr(formatUsd(order.refundedUsdUnits)) })}
          </p>
        )}
        {order.compensatedUsdUnits > 0 && (
          <p className="text-sm font-medium">
            {ts('orders.compensated', { amount: ltr(formatUsd(order.compensatedUsdUnits)) })}
          </p>
        )}
      </section>
      <section aria-labelledby="timeline-title" className="flex flex-col gap-2">
        <h2 id="timeline-title" className="text-lg font-bold">
          {ts('orders.timeline')}
        </h2>
        <ol className="flex flex-col gap-2 border-s-2 border-border ps-4">
          {timelineEntries(order).map((entry) => (
            <li
              key={`${entry.step}:${entry.at ?? 'next'}`}
              className={`flex flex-wrap justify-between gap-2 text-sm ${entry.state === 'upcoming' ? 'text-muted-foreground' : ''} ${entry.state === 'current' ? 'font-bold' : ''}`}
            >
              <span>{stepText(entry.step)}</span>
              {entry.at && (
                <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
      <dl className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <Row label={order.game.nameAr}>
          <bdi className="font-bold">{order.product.nameAr}</bdi>
          {order.quantity > 1 && ` × ${order.quantity}`}
        </Row>
        {order.playerName && (
          <Row label={ts('orders.player')}>
            <span className="flex items-center gap-2 font-bold">
              <UserRoundCheckIcon className="size-4" aria-hidden="true" />
              <bdi>{order.playerName}</bdi>
            </span>
          </Row>
        )}
        {order.fields.map((field) => (
          <Row key={field.key} label={field.labelAr}>
            <bdi dir="ltr" className="font-bold break-all">
              {field.value}
            </bdi>
          </Row>
        ))}
        <Row label={ts('orders.total')}>
          <ShopMoney usd={order.totalSellUsdUnits} syp={order.totalSellSypUnits} />
        </Row>
      </dl>
      {order.codes.length > 0 && (
        <section aria-labelledby="codes-title" className="flex flex-col gap-2">
          <h2 id="codes-title" className="text-lg font-bold">
            {ts('orders.codes')}
          </h2>
          <ul className="flex flex-col gap-2">
            {order.codes.map((code) => (
              <CodeRow key={code.id} slug={slug} number={order.number} code={code} />
            ))}
          </ul>
        </section>
      )}
      {order.verificationCode && (
        <section
          aria-labelledby="receipt-title"
          className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4"
        >
          <LazyVerificationQr code={order.verificationCode} size={96} label={to('qr.title')} />
          <div className="flex flex-col gap-1">
            <h2 id="receipt-title" className="font-bold">
              {ts('orders.receipt')}
            </h2>
            <bdi dir="ltr" className="text-sm text-muted-foreground">
              {order.verificationCode}
            </bdi>
          </div>
        </section>
      )}
      <section className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <p className="flex items-center gap-2 font-medium">
          <CircleHelpIcon className="size-5" aria-hidden="true" />
          {ts('orders.help')}
        </p>
        <Button
          variant="outline"
          size="xl"
          render={
            <Link
              prefetch={false}
              href={
                order.help.openTicketId
                  ? shopPath(slug, `/support/${order.help.openTicketId}`)
                  : `${shopPath(slug, '/support/new')}?${new URLSearchParams({ order: order.number })}`
              }
            />
          }
        >
          {ts('orders.helpOpen')}
        </Button>
      </section>
    </Frame>
  );
}

function CodeRow({
  slug,
  number,
  code,
}: {
  slug: string;
  number: string;
  code: ShopOrder['codes'][number];
}) {
  const [value, setValue] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function reveal() {
    setPending(true);
    setFailure(null);
    const result = await revealShopCode(slug, number, code.id);
    setPending(false);
    if (result.ok) setValue(result.data.code);
    else setFailure(errorText(result.reason));
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <bdi dir="ltr" className="font-bold break-all tabular-nums">
          {value ?? code.masked}
        </bdi>
        {value ? (
          <CopyButton value={value} label={ts('orders.copy')} />
        ) : (
          <Button variant="outline" size="xl" disabled={pending} onClick={() => void reveal()}>
            <EyeIcon aria-hidden="true" />
            {ts('orders.reveal')}
          </Button>
        )}
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
    </li>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Frame({ back, children }: { back: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:py-10">
      {back}
      {children}
    </div>
  );
}
