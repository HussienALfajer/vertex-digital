'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { CircleAlertIcon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ts } from './i18n';
import { shopPath } from './paths';
import { refreshShopCustomer, type ShopCustomer, useShopCustomer } from './session';

/**
 * A shop customer's page (wallet, orders, support, account): signed out, it goes to the shop's
 * sign-in and comes back here. Static shells: the data loads in the browser.
 */
export function useSignedInShopCustomer(slug: string): ShopCustomer {
  const router = useRouter();
  const pathname = usePathname();
  const customer = useShopCustomer(slug);
  useEffect(() => {
    if (customer.status !== 'signedOut') return;
    router.replace(`${shopPath(slug, '/sign-in')}?${new URLSearchParams({ next: pathname })}`);
  }, [customer.status, router, slug, pathname]);
  return customer;
}

/** A failed read with a retry (S26 screens: error states everywhere). */
export function ReadFailed({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={<CircleAlertIcon />}
      title={title}
      description={ts('error.body')}
      action={
        <Button size="xl" variant="outline" onClick={onRetry}>
          {ts('error.retry')}
        </Button>
      }
    />
  );
}

/** The session read failed: read it again. */
export function SessionFailed({ slug }: { slug: string }) {
  return <ReadFailed title={ts('error.title')} onRetry={() => void refreshShopCustomer(slug)} />;
}
