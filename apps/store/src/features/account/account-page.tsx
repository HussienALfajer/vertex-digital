'use client';

import type { CustomerProfile } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { MerchantCard } from '@/features/merchant/merchant-card';
import { NotificationPreferencesCard } from '@/features/notifications/preferences-card';
import { t } from '@/lib/i18n';
import { readSession } from '@/lib/session';
import { PasswordCard } from './password-card';
import { ProfileCard } from './profile-card';
import { type CustomerSession, getProfile, listSessions } from './requests';
import { SessionsCard } from './sessions-card';

// S22 PK2, PK4: the passkeys card, with WebAuthn and its strings, loads on its own.
const PasskeysCard = dynamic(
  () => import('@/features/passkeys/passkeys-card').then((m) => m.PasskeysCard),
  { ssr: false },
);

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready';
      profile: CustomerProfile;
      sessions: CustomerSession[];
      currentToken: string;
    };

/**
 * The customer's account (S01 screens): profile, the merchant card (S20), password, passkeys (S22), signed-in
 * devices and the email choices of S05 (rule NT8). Read in the browser, never cached; without a session the customer
 * signs in and comes back here.
 */
export function AccountPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    // The header's session read, shared while in flight (A01-16): its token marks this device.
    const [profile, sessions, session] = await Promise.all([
      getProfile(),
      listSessions(),
      readSession(),
    ]);
    if (!profile.ok && profile.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Faccount');
      return;
    }
    const currentToken = session?.session?.token;
    // Signed in, yet no token read: the device could not be told apart, so the page says it failed.
    if (!profile.ok || !sessions.ok || !currentToken) return setState({ status: 'failed' });
    setState({ status: 'ready', profile: profile.data, sessions: sessions.data, currentToken });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Changes part of a loaded account, from the latest state (answers can arrive late). */
  const update = (changes: Partial<Extract<State, { status: 'ready' }>>) =>
    setState((previous) => (previous.status === 'ready' ? { ...previous, ...changes } : previous));

  if (state.status === 'loading') return <AccountSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('account.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('account.retry')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <ProfileCard profile={state.profile} onSaved={(profile) => update({ profile })} />
      <MerchantCard
        profile={state.profile}
        onTermsAccepted={() =>
          void getProfile().then((profile) => profile.ok && update({ profile: profile.data }))
        }
      />
      <PasswordCard
        email={state.profile.email}
        onChanged={() => {
          // Other sessions were signed out (rule C11): the list shows only this one now.
          void listSessions().then(
            (sessions) => sessions.ok && update({ sessions: sessions.data }),
          );
        }}
      />
      <PasskeysCard />
      <SessionsCard
        sessions={state.sessions}
        currentToken={state.currentToken}
        onRevoked={(token) =>
          // From the latest list: a refresh may have landed since this render (A01-15).
          setState((previous) =>
            previous.status === 'ready'
              ? {
                  ...previous,
                  sessions: previous.sessions.filter((session) => session.token !== token),
                }
              : previous,
          )
        }
      />
      <NotificationPreferencesCard />
    </div>
  );
}

/** The cards' shapes while the account loads. */
function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      {[3, 2, 2].map((rows, card) => (
        <Card
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders without identity.
          key={card}
        >
          {/* Plain blocks: a skeleton inside the title's <h2> or the description's <p> is
              invalid HTML, which the browser rewrites and React then fails to hydrate. */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders without identity.
            <Skeleton key={row} className="h-11 w-full" />
          ))}
        </Card>
      ))}
    </div>
  );
}
