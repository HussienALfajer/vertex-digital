'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Switch } from '@vertex-digital/ui/components/switch';
import { BellIcon, DownloadIcon, KeyRoundIcon, LogOutIcon } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { ThemeToggle } from '@/components/theme-toggle';
import { formatPhone } from '@/features/auth/phone';
import { sameKey } from '@/features/push/rules';
import { useInstall } from '@/features/pwa/install-button';
import { errorText } from '@/lib/errors';
import { ts } from './i18n';
import { shopPath } from './paths';
import {
  devicePermission,
  deviceSupport,
  disableShopPush,
  enableShopPush,
  forgetShopDevice,
  pushPublicKey,
  shopSubscription,
} from './push';
import { shopSignOut } from './requests';
import { refreshShopCustomer } from './session';
import { SessionFailed, useSignedInShopCustomer } from './signed-in';

/**
 * "حسابي" in a shop (S26 screens): the name, phone and email (the merchant edits the name and
 * phone, CA8), a new password by email code, the shop's notifications on this device (SP1), the
 * app install, and sign-out (the shop's session only).
 */
export function ShopAccountPage({ slug }: { slug: string }) {
  const customer = useSignedInShopCustomer(slug);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await forgetShopDevice(slug);
    await shopSignOut(slug);
    await refreshShopCustomer(slug);
    window.location.assign(shopPath(slug));
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:py-10">
      <PageHeader title={ts('account.title')} />
      {customer.status === 'failed' ? (
        <SessionFailed slug={slug} />
      ) : customer.status !== 'signedIn' ? (
        <>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : (
        <>
          <Card>
            <dl className="flex flex-col gap-3">
              <Item label={ts('account.name')}>{customer.profile.name}</Item>
              <Item label={ts('account.phone')}>
                <bdi dir="ltr">{formatPhone(customer.profile.phone)}</bdi>
              </Item>
              <Item label={ts('account.email')}>
                <bdi dir="ltr">{customer.profile.email}</bdi>
              </Item>
            </dl>
            <p className="text-sm text-muted-foreground">{ts('account.changeHint')}</p>
          </Card>
          <Card>
            <h2 className="flex items-center gap-2 font-bold">
              <KeyRoundIcon className="size-5" aria-hidden="true" />
              {ts('account.password')}
            </h2>
            <p className="text-sm text-muted-foreground">{ts('account.passwordHint')}</p>
            <Button
              variant="outline"
              size="xl"
              className="self-start"
              render={<Link href={shopPath(slug, '/reset')} prefetch={false} />}
            >
              {ts('account.passwordChange')}
            </Button>
          </Card>
          <Card>
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-bold">{ts('account.theme')}</h2>
              <ThemeToggle />
            </div>
          </Card>
          <PushCard slug={slug} />
          <InstallCard />
          <Button
            variant="outline"
            size="xl"
            className="self-start"
            disabled={signingOut}
            onClick={() => void signOut()}
          >
            <LogOutIcon aria-hidden="true" />
            {ts('auth.signOut')}
          </Button>
        </>
      )}
    </div>
  );
}

type Push =
  | { status: 'loading' }
  | { status: 'off' }
  | { status: 'ready'; publicKey: string; subscribed: boolean };

/** SP1, S15 PC2/PC4: the shop's pushes on this device, through the shop's own worker. */
function PushCard({ slug }: { slug: string }) {
  const [push, setPush] = useState<Push>({ status: 'loading' });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const reload = useCallback(async () => {
    const publicKey = await pushPublicKey();
    if (!publicKey || deviceSupport() !== 'push') return setPush({ status: 'off' });
    const held = await shopSubscription(slug);
    setPush({
      status: 'ready',
      publicKey,
      subscribed: held !== null && sameKey(held.options.applicationServerKey, publicKey),
    });
  }, [slug]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggle(on: boolean) {
    if (push.status !== 'ready') return;
    setBusy(true);
    setMessage(null);
    if (on) {
      const outcome = await enableShopPush(slug, push.publicKey);
      if (outcome.outcome === 'denied') setMessage(ts('account.pushBlocked'));
      else if (outcome.outcome === 'failed') setMessage(errorText(outcome.reason));
    } else {
      const removed = await disableShopPush(slug);
      if (!removed.ok) setMessage(errorText(removed.reason));
    }
    await reload();
    setBusy(false);
  }

  return (
    <Card>
      <h2 className="flex items-center gap-2 font-bold">
        <BellIcon className="size-5" aria-hidden="true" />
        {ts('account.notifications')}
      </h2>
      <p className="text-sm text-muted-foreground">{ts('account.notificationsHint')}</p>
      {push.status === 'loading' ? (
        <Skeleton className="h-11 w-48" />
      ) : push.status === 'off' ? (
        <p className="text-sm text-muted-foreground">{ts('account.pushUnsupported')}</p>
      ) : devicePermission() === 'denied' && !push.subscribed ? (
        <FormAlert tone="warning">{ts('account.pushBlocked')}</FormAlert>
      ) : (
        <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3">
          <Switch
            id={id}
            checked={push.subscribed}
            disabled={busy}
            onCheckedChange={(checked) => void toggle(checked)}
          />
          <span>{push.subscribed ? ts('account.pushOn') : ts('account.pushOff')}</span>
        </label>
      )}
      {message && <FormAlert>{message}</FormAlert>}
    </Card>
  );
}

/** S15 IN1: "ثبّت تطبيق المتجر", when the browser can install this shop. */
function InstallCard() {
  const { mode, start, steps } = useInstall();
  if (!mode) return null;
  return (
    <Card>
      <h2 className="flex items-center gap-2 font-bold">
        <DownloadIcon className="size-5" aria-hidden="true" />
        {ts('account.install')}
      </h2>
      <p className="text-sm text-muted-foreground">{ts('account.installHint')}</p>
      <Button size="xl" className="self-start" onClick={start}>
        {ts('account.install')}
      </Button>
      {steps}
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      {children}
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
