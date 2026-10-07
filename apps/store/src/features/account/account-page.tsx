'use client';

import type { CustomerProfile } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { PasswordCard } from './password-card';
import { ProfileCard } from './profile-card';
import { type CustomerSession, currentSessionToken, getProfile, listSessions } from './requests';
import { SessionsCard } from './sessions-card';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready';
      profile: CustomerProfile;
      sessions: CustomerSession[];
      currentToken: string | null;
    };

/**
 * The customer's account (S01 screens): profile, password and signed-in devices. Read in the
 * browser, never cached; without a session the customer signs in and comes back here.
 */
export function AccountPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    const [profile, sessions, currentToken] = await Promise.all([
      getProfile(),
      listSessions(),
      currentSessionToken(),
    ]);
    if (!profile.ok && profile.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Faccount');
      return;
    }
    if (!profile.ok || !sessions.ok) return setState({ status: 'failed' });
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
      <PasswordCard
        onChanged={() => {
          // Other sessions were signed out (rule C11): the list shows only this one now.
          void listSessions().then(
            (sessions) => sessions.ok && update({ sessions: sessions.data }),
          );
        }}
      />
      <SessionsCard
        sessions={state.sessions}
        currentToken={state.currentToken}
        onRevoked={(token) =>
          update({ sessions: state.sessions.filter((session) => session.token !== token) })
        }
      />
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
