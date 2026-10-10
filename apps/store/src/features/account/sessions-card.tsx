'use client';

import { describeUserAgent } from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vertex-digital/ui/components/alert-dialog';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
import { MonitorSmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { clearStoredCart } from '@/features/cart/cart-keys';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { type CustomerSession, revokeAllSessions, revokeSession } from './requests';

/**
 * Every signed-in device, newest activity first (rule C14): sign out one, or every one with a
 * confirmation. Signing out this device, either way, ends on the sign-in page.
 */
export function SessionsCard({
  sessions,
  currentToken,
  onRevoked,
}: {
  sessions: CustomerSession[];
  currentToken: string | null;
  onRevoked: (token: string) => void;
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const revoke = async (token: string) => {
    setFailure(null);
    setRevoking(token);
    const result = await revokeSession(token);
    setRevoking(null);
    if (!result.ok) return setFailure(result.reason);
    // This device is now signed out: the same as signing out (edge case 12), so the cart goes
    // too (S10 rule CT1).
    if (token === currentToken) {
      clearStoredCart();
      return window.location.assign('/sign-in');
    }
    onRevoked(token);
  };

  const revokeAll = async () => {
    setRevokingAll(true);
    const result = await revokeAllSessions();
    if (result.ok) {
      clearStoredCart();
      return window.location.assign('/sign-in?notice=signed-out');
    }
    setRevokingAll(false);
    setConfirmOpen(false);
    setFailure(result.reason);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.sessions.title')}</CardTitle>
        <CardDescription>{t('account.sessions.description')}</CardDescription>
      </CardHeader>
      <ul className="flex flex-col">
        {sorted.map((session) => {
          const { browser, system } = describeUserAgent(session.userAgent);
          const device = t('account.sessions.device', {
            browser: browser === 'Unknown' ? t('account.sessions.unknown') : browser,
            system: system === 'Unknown' ? t('account.sessions.unknown') : system,
          });
          const current = session.token === currentToken;
          return (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
            >
              <div className="flex min-w-0 items-start gap-3">
                <MonitorSmartphoneIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{device}</span>
                    {current && <Badge tone="success">{t('account.sessions.thisDevice')}</Badge>}
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {t('account.sessions.lastActive', { date: formatDateTime(session.updatedAt) })}
                  </span>
                  {session.ipAddress && (
                    <span className="text-sm text-muted-foreground">
                      {t('account.sessions.ip', { ip: session.ipAddress })}
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="xl"
                aria-label={t('account.sessions.signOutLabel', { device })}
                disabled={revoking !== null}
                onClick={() => revoke(session.token)}
              >
                {t('account.sessions.signOut')}
              </Button>
            </li>
          );
        })}
      </ul>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Button
          variant="destructive"
          size="xl"
          className="self-start"
          onClick={() => setConfirmOpen(true)}
        >
          {t('account.sessions.signOutEverywhere')}
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.sessions.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('account.sessions.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="xl" />}>
              {t('account.sessions.cancel')}
            </AlertDialogClose>
            <Button variant="destructive" size="xl" disabled={revokingAll} onClick={revokeAll}>
              {t('account.sessions.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
