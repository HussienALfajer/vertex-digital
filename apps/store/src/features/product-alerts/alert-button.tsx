'use client';

import { formatUsd, type ProductAlert, type ProductAlertKind } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { BellIcon, BellOffIcon, BellRingIcon, LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { useCustomer } from '@/features/purchase/session';
import { PushCard } from '@/features/push/push-card';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { ta } from './i18n';
import { cancelProductAlert, createProductAlert, readGameAlerts } from './requests';

/**
 * "نبّهني عند التوفر" on an unavailable pack and "نبّهني عند انخفاض السعر" on an available one
 * (S22 PA1, PA2): signed out it leads to sign-in and back; set, it says so and offers "إلغاء
 * التنبيه", and suggests push on this device (the S15 card's own rules decide). A refusal that
 * says the pack changed refreshes the page.
 */
export function AlertButton({
  productId,
  gameId,
  kind,
}: {
  productId: string;
  gameId: string;
  kind: ProductAlertKind;
}) {
  const router = useRouter();
  const customer = useCustomer();
  const [alert, setAlert] = useState<ProductAlert | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [justSet, setJustSet] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (customer.status !== 'signedIn') return;
    let live = true;
    void readGameAlerts(gameId).then((items) => {
      if (live)
        setAlert(items.find((item) => item.product.id === productId && item.kind === kind) ?? null);
    });
    return () => {
      live = false;
    };
  }, [customer.status, gameId, productId, kind]);

  if (customer.status === 'loading') return null;
  if (customer.status === 'signedOut') {
    const next =
      typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
    return (
      <Button
        variant="ghost"
        size="xl"
        className="w-full px-3"
        render={<Link href={`/sign-in?next=${encodeURIComponent(next)}`} prefetch={false} />}
      >
        <BellIcon aria-hidden="true" />
        {ta(`button.${kind}`)}
      </Button>
    );
  }

  async function set() {
    setBusy(true);
    setFailure(null);
    const result = await createProductAlert(productId, kind);
    setBusy(false);
    if (result.ok) {
      setAlert(result.data);
      setJustSet(true);
      return;
    }
    setFailure(result.reason);
    if (result.reason === 'PRODUCT_ALERT_INVALID') router.refresh();
  }

  async function cancel(current: ProductAlert) {
    setBusy(true);
    setFailure(null);
    const result = await cancelProductAlert(current.id);
    setBusy(false);
    if (result.ok || result.reason === 'NOT_FOUND') {
      setAlert(null);
      setJustSet(false);
      return;
    }
    setFailure(result.reason);
  }

  const icon = busy ? (
    <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
  ) : (
    <BellIcon aria-hidden="true" />
  );

  return (
    <div className="flex flex-col gap-2" data-testid={`alert-${kind}`}>
      {alert ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <BellRingIcon className="size-4" aria-hidden="true" />
            {kind === 'available' ? ta('button.availableSet') : ta('button.priceDropSet')}
          </span>
          <Button
            variant="ghost"
            size="xl"
            className="px-3"
            disabled={busy}
            onClick={() => void cancel(alert)}
          >
            <BellOffIcon aria-hidden="true" />
            {ta('button.cancel')}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="xl"
          className="w-full"
          disabled={busy || alert === undefined}
          onClick={() => void set()}
        >
          {icon}
          {ta(`button.${kind}`)}
        </Button>
      )}
      {justSet && alert && (
        <p className="text-sm text-muted-foreground">
          {alert.kind === 'price_drop' && alert.baselinePriceUsdUnits !== null
            ? ta('set.price_drop', { price: ltr(formatUsd(alert.baselinePriceUsdUnits)) })
            : ta('set.available')}
        </p>
      )}
      {justSet && <PushCard kind="alert" />}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
    </div>
  );
}
