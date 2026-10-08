'use client';

import type { Deposit } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ArrowDownToLineIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { amountText, STATUS_TONES, statusText } from './amounts';
import { listDeposits } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; deposits: Deposit[]; nextCursor: string | null };

/** "إيداعاتي" (S03 screens): newest first, with "load more"; each opens its page. */
export function DepositsList() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listDeposits();
    if (!page.ok && page.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Fwallet%2Fdeposits');
      return;
    }
    if (!page.ok) return setState({ status: 'failed' });
    setState({ status: 'ready', deposits: page.data.items, nextCursor: page.data.nextCursor });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (cursor: string) => {
    setMoreFailure(null);
    setLoadingMore(true);
    const page = await listDeposits(cursor);
    setLoadingMore(false);
    if (!page.ok) return setMoreFailure(page.reason);
    setState((previous) =>
      previous.status === 'ready'
        ? {
            ...previous,
            deposits: [...previous.deposits, ...page.data.items],
            nextCursor: page.data.nextCursor,
          }
        : previous,
    );
  };

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('deposits.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('deposits.retry')}
          </Button>
        }
      />
    );
  }
  if (state.deposits.length === 0) {
    return (
      <EmptyState
        icon={<ArrowDownToLineIcon />}
        title={t('deposits.list.emptyTitle')}
        description={t('deposits.list.emptyBody')}
        action={
          <Button size="xl" render={<Link href="/wallet/deposit" />}>
            {t('deposits.newDeposit')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {state.deposits.map((deposit) => (
          <li key={deposit.id}>
            <Link
              href={`/wallet/deposits/${deposit.id}`}
              className="flex min-h-11 items-center gap-3 p-4 hover:bg-muted"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="font-bold tabular-nums">
                  {amountText(deposit.currency, deposit.declaredAmountUnits)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(`deposits.methods.${deposit.method}`)} ·{' '}
                  <bdi dir="ltr">{deposit.referenceCode}</bdi> · {formatDateTime(deposit.createdAt)}
                </p>
              </div>
              <Badge tone={STATUS_TONES[deposit.status]}>{statusText(deposit)}</Badge>
              <ChevronRightIcon
                className="size-5 text-muted-foreground rtl:-scale-x-100"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
      {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
      {state.nextCursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void loadMore(state.nextCursor as string)}
        >
          {loadingMore ? t('wallet.loadingMore') : t('wallet.loadMore')}
        </Button>
      )}
    </div>
  );
}
