'use client';

import { Avatar } from '@vertex-digital/ui/components/avatar';
import { Button } from '@vertex-digital/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHeader,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vertex-digital/ui/components/dropdown-menu';
import {
  BellRingIcon,
  DownloadIcon,
  IdCardIcon,
  LogOutIcon,
  MoonIcon,
  ShoppingBagIcon,
  StoreIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { forgetThisBrowser } from '@/features/account/signed-out';
import { useInstall } from '@/features/pwa/install-button';
import { t } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

/**
 * The signed-in customer's menu in the header: the account page, the orders (S08), the saved
 * player IDs (S10 rule SP5), "أدوات التاجر" for a merchant (S21 MA1), "ثبّت التطبيق" when possible (S15 IN1), sign-out, which also clears
 * the cart (S10 rule CT1) and makes the browser forget its push subscription (S15 PS5).
 */
export function AccountMenu({
  name,
  email,
  merchant,
}: {
  name: string;
  email: string;
  merchant: boolean;
}) {
  const { theme, toggle } = useTheme();
  const install = useInstall();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const signOut = async () => {
    setSignOutFailed(false);
    const response = await fetch('/api/auth/sign-out', {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => null);
    // Only a confirmed sign-out leaves the page: on a shared device, a failure that looked like
    // one would leave the account open for the next person (2026-10-15 audit). 401: the session
    // had already ended, which is signed out all the same.
    if (!response || (!response.ok && response.status !== 401)) {
      setSignOutFailed(true);
      return;
    }
    await forgetThisBrowser();
    // A full load, so nothing rendered for the customer stays on screen.
    window.location.assign('/');
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="xl" className="px-2" aria-label={t('header.menu')} />
          }
        >
          <Avatar name={name} size="md" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuHeader>
            <span className="font-medium">{name}</span>
            <span dir="ltr" className="text-end text-sm text-muted-foreground">
              {email}
            </span>
          </DropdownMenuHeader>
          <DropdownMenuItem className="min-h-11" render={<Link href="/account" />}>
            <UserRoundIcon />
            {t('header.account')}
          </DropdownMenuItem>
          {merchant && (
            <DropdownMenuItem
              className="min-h-11"
              render={<Link href="/merchant" prefetch={false} />}
            >
              <StoreIcon />
              {t('header.merchantTools')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="min-h-11" render={<Link href="/orders" />}>
            <ShoppingBagIcon />
            {t('header.orders')}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" render={<Link href="/account/players" />}>
            <IdCardIcon />
            {t('header.players')}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" render={<Link href="/account/alerts" />}>
            <BellRingIcon />
            {t('header.alerts')}
          </DropdownMenuItem>
          {install.mode && (
            <DropdownMenuItem className="min-h-11" onClick={install.start}>
              <DownloadIcon />
              {t('pwa.install')}
            </DropdownMenuItem>
          )}
          {/* On phones the header has no room for the theme switch once signed in. */}
          <DropdownMenuItem className="min-h-11 sm:hidden" onClick={toggle}>
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            {theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onClick={signOut}>
            <LogOutIcon className="rtl:-scale-x-100" />
            {t('header.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {install.steps}
      {signOutFailed && (
        <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg">
          <FormAlert>{t('header.signOutFailed')}</FormAlert>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="xl" onClick={() => setSignOutFailed(false)}>
              {t('header.dismiss')}
            </Button>
            <Button size="xl" onClick={signOut}>
              {t('header.signOutRetry')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
