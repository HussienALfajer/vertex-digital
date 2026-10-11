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
  DownloadIcon,
  IdCardIcon,
  LogOutIcon,
  MoonIcon,
  ShoppingBagIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react';
import Link from 'next/link';
import { clearStoredCart } from '@/features/cart/cart-keys';
import { useInstall } from '@/features/pwa/install-button';
import { t } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

/**
 * The signed-in customer's menu in the header: the account page, the orders (S08), the saved
 * player IDs (S10 rule SP5), "ثبّت التطبيق" when possible (S15 IN1), sign-out, which also clears
 * the cart (S10 rule CT1) and makes the browser forget its push subscription (S15 PS5).
 */
export function AccountMenu({ name, email }: { name: string; email: string }) {
  const { theme, toggle } = useTheme();
  const install = useInstall();
  const signOut = async () => {
    clearStoredCart();
    // Its own chunk, as the header's refresh: fetched only on sign-out.
    await import('@/features/push/device').then((device) => device.forgetDevice()).catch(() => {});
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(
      () => {},
    );
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
          <DropdownMenuItem className="min-h-11" render={<Link href="/orders" />}>
            <ShoppingBagIcon />
            {t('header.orders')}
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" render={<Link href="/account/players" />}>
            <IdCardIcon />
            {t('header.players')}
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
    </>
  );
}
