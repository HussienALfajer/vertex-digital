'use client';

import { formatUsd, type ProductAlert } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { BellIcon, CircleAlertIcon, PackageIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { ta } from './i18n';
import { cancelProductAlert, listProductAlerts } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; active: ProductAlert[]; ended: ProductAlert[] };

/**
 * "تنبيهاتي" (S22 PA7): the active alerts with the pack, the kind, the price when set and the
 * expiry, each with "إلغاء"; then the newest 20 ended ones. Read in the browser with the session,
 * never cached.
 */
export function AlertsPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const [active, ended] = await Promise.all([
      listProductAlerts({ status: 'active' }),
      listProductAlerts({ status: 'ended' }),
    ]);
    if (
      (!active.ok && active.reason === 'UNAUTHORIZED') ||
      (!ended.ok && ended.reason === 'UNAUTHORIZED')
    ) {
      router.replace(`/sign-in?next=${encodeURIComponent('/account/alerts')}`);
      return;
    }
    setState(
      active.ok && ended.ok
        ? { status: 'ready', active: active.data.items, ended: ended.data.items }
        : { status: 'failed' },
    );
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel(alert: ProductAlert) {
    setBusy(alert.id);
    setFailure(null);
    const result = await cancelProductAlert(alert.id);
    setBusy(null);
    if (!result.ok && result.reason !== 'NOT_FOUND') return setFailure(result.reason);
    await load();
  }

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={ta('page.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {ta('page.retry')}
          </Button>
        }
      />
    );
  }
  if (state.active.length === 0 && state.ended.length === 0) {
    return (
      <EmptyState
        icon={<BellIcon />}
        title={ta('page.empty')}
        action={
          <Button size="xl" render={<Link href="/" />}>
            {ta('page.browse')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <section className="flex flex-col gap-3" aria-labelledby="alerts-active">
        <h2 id="alerts-active" className="text-lg font-bold">
          {ta('page.active')}
        </h2>
        {state.active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{ta('page.empty')}</p>
        ) : (
          state.active.map((alert) => (
            <AlertCard key={alert.id} alert={alert}>
              <Button
                variant="outline"
                size="xl"
                disabled={busy === alert.id}
                aria-label={ta('page.cancelLabel', { name: alert.product.nameAr })}
                onClick={() => void cancel(alert)}
              >
                {ta('page.cancel')}
              </Button>
            </AlertCard>
          ))
        )}
      </section>
      {state.ended.length > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="alerts-ended">
          <h2 id="alerts-ended" className="text-lg font-bold">
            {ta('page.ended')}
          </h2>
          {state.ended.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </section>
      )}
    </div>
  );
}

function AlertCard({ alert, children }: { alert: ProductAlert; children?: React.ReactNode }) {
  const ended = alert.status !== 'active';
  return (
    <Card className={`flex-row items-center gap-3 ${ended ? 'opacity-80' : ''}`}>
      {alert.game.cover ? (
        // biome-ignore lint/performance/noImgElement: catalog images are stored re-encoded and served immutable by the API (S06).
        <img
          src={alert.game.cover.url}
          alt=""
          width={56}
          height={56}
          className="size-14 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center rounded-md bg-muted">
          <PackageIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link
          href={`/games/${alert.game.slug}?pack=${alert.product.id}`}
          prefetch={false}
          className="font-medium break-words underline-offset-4 hover:underline"
        >
          <bdi>{alert.product.nameAr}</bdi>
        </Link>
        <span className="text-sm text-muted-foreground">
          <bdi>{alert.game.nameAr}</bdi>
        </span>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={ended ? 'neutral' : 'gold'}>{ta(`page.kinds.${alert.kind}`)}</Badge>
          {alert.baselinePriceUsdUnits !== null && (
            <span className="text-muted-foreground">
              {ta('page.baseline', { price: ltr(formatUsd(alert.baselinePriceUsdUnits)) })}
            </span>
          )}
          <span className="text-muted-foreground">
            {alert.status === 'active'
              ? ta('page.expires', { date: formatDateTime(alert.expiresAt) })
              : alert.status === 'sent'
                ? ta('page.statuses.sent', {
                    date: formatDateTime(alert.sentAt ?? alert.expiresAt),
                  })
                : ta(`page.statuses.${alert.status}`)}
          </span>
        </div>
      </div>
      {children}
    </Card>
  );
}
