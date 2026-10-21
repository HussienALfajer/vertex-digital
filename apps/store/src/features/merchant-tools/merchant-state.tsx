'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon, StoreIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Result } from '@/lib/api';
import { tm } from './i18n';

export type PageState<Data> =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'not_merchant' }
  | { status: 'ready'; data: Data };

/**
 * A merchant page's read (S21 MA1), in the browser with the session cookie: without a session the
 * customer signs in and comes back; a customer who is not a merchant sees why. `reload` reads again.
 */
export function useMerchantRead<Data>(read: () => Promise<Result<Data>>) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<PageState<Data>>({ status: 'loading' });

  const reload = useCallback(async () => {
    const result = await read();
    if (result.ok) return setState({ status: 'ready', data: result.data });
    if (result.reason === 'UNAUTHORIZED') {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
      return;
    }
    setState({ status: result.reason === 'NOT_MERCHANT' ? 'not_merchant' : 'failed' });
  }, [read, router, pathname]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, setState, reload };
}

/** What a merchant page shows before it is ready. */
export function MerchantPageStatus({
  state,
  onRetry,
  skeleton,
}: {
  state: Exclude<PageState<unknown>, { status: 'ready' }>;
  onRetry: () => void;
  skeleton: React.ReactNode;
}) {
  if (state.status === 'loading') return <>{skeleton}</>;
  if (state.status === 'not_merchant') {
    return (
      <EmptyState
        icon={<StoreIcon />}
        title={tm('common.notMerchant')}
        description={tm('common.notMerchantHint')}
        action={
          <Button variant="outline" size="xl" render={<Link href="/account" prefetch={false} />}>
            {tm('common.toAccount')}
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<CircleAlertIcon />}
      title={tm('common.loadFailed')}
      action={
        <Button variant="outline" size="xl" onClick={onRetry}>
          {tm('common.retry')}
        </Button>
      }
    />
  );
}

/** Rows of placeholders while a page loads. */
export function MerchantSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
        <Skeleton key={index} className="h-28 w-full" />
      ))}
    </div>
  );
}
