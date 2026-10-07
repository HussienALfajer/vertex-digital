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
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/lib/i18n';

/** The signed-in customer's menu in the header: the account page and sign-out. */
export function AccountMenu({ name, email }: { name: string; email: string }) {
  const signOut = async () => {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(
      () => {},
    );
    // A full load, so nothing rendered for the customer stays on screen.
    window.location.assign('/');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="xl" className="px-2" aria-label={t('header.menu')} />}
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
        <DropdownMenuItem className="min-h-11" onClick={signOut}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('header.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
